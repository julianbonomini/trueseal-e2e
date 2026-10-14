package main

import (
	"database/sql"
	"testing"

	_ "modernc.org/sqlite"
)

// Regression coverage for the E3b root cause: the inbox is at-least-once,
// so the helper must target the envelope NEWER than the caller's watermark
// and must not fail on extra rows (an un-acked leftover from an earlier
// subtest, or a legitimate outbox-pump retry). Pre-fix, wait-queued matched
// "any row" and duplicate fataled when the inbox held more than one row —
// which is exactly how a leftover raced the duplicate step into
// "expected exactly one queued envelope, found 2".

func openTestDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", t.TempDir()+"/inbox.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	_, err = db.Exec(`
		CREATE TABLE inbox (
			id          INTEGER PRIMARY KEY AUTOINCREMENT,
			recipient   BLOB    NOT NULL CHECK(length(recipient) = 32),
			envelope    BLOB    NOT NULL,
			expires_at  INTEGER NOT NULL
		)`)
	if err != nil {
		t.Fatal(err)
	}
	return db
}

func insertRow(t *testing.T, db *sql.DB, envelope string) int64 {
	t.Helper()
	res, err := db.Exec(`INSERT INTO inbox (recipient, envelope, expires_at) VALUES (?, ?, ?)`,
		make([]byte, 32), []byte(envelope), 999)
	if err != nil {
		t.Fatal(err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func countRows(t *testing.T, db *sql.DB) int {
	t.Helper()
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM inbox`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestMaxIDEmptyAndNonEmpty(t *testing.T) {
	db := openTestDB(t)
	if got := maxID(db); got != 0 {
		t.Fatalf("empty inbox: maxID = %d, want 0", got)
	}
	id := insertRow(t, db, "a")
	if got := maxID(db); got != id {
		t.Fatalf("maxID = %d, want %d", got, id)
	}
}

func TestWaitQueuedIgnoresRowsAtOrBelowTheWatermark(t *testing.T) {
	db := openTestDB(t)
	leftover := insertRow(t, db, "leftover-from-an-earlier-subtest")
	// The leftover alone must NOT satisfy wait-queued when it is at/below
	// the watermark — pre-fix this returned immediately and let the test
	// race ahead of the envelope it had actually sent.
	if id, err := firstNewerThan(db, leftover); err != nil || id != 0 {
		t.Fatalf("firstNewerThan(leftover) = %d, %v; want 0, nil", id, err)
	}
	newRow := insertRow(t, db, "the-envelope-this-test-sent")
	if id, err := firstNewerThan(db, leftover); err != nil || id != newRow {
		t.Fatalf("firstNewerThan(leftover) = %d, %v; want %d, nil", id, err, newRow)
	}
}

func TestDuplicateTargetsOnlyTheNewRowAndToleratesExtras(t *testing.T) {
	db := openTestDB(t)
	leftover := insertRow(t, db, "leftover")
	insertRow(t, db, "new-envelope")              // the push this test sent
	insertRow(t, db, "new-envelope")              // a legitimate pump retry

	duplicate(db, leftover)

	// Exactly one copy of the targeted row was added (three rows became
	// four) — pre-fix this fataled with "expected exactly one queued
	// envelope, found 3".
	if got := countRows(t, db); got != 4 {
		t.Fatalf("row count = %d, want 4", got)
	}
	var copies int
	if err := db.QueryRow(`SELECT COUNT(*) FROM inbox WHERE envelope = ?`, []byte("new-envelope")).Scan(&copies); err != nil {
		t.Fatal(err)
	}
	if copies != 3 {
		t.Fatalf("new-envelope copies = %d, want 3 (push + retry + duplicate)", copies)
	}
	var leftoverCopies int
	if err := db.QueryRow(`SELECT COUNT(*) FROM inbox WHERE envelope = ?`, []byte("leftover")).Scan(&leftoverCopies); err != nil {
		t.Fatal(err)
	}
	if leftoverCopies != 1 {
		t.Fatalf("leftover copies = %d, want 1 (the duplicate must not copy the wrong row)", leftoverCopies)
	}
}

func TestDuplicateWithoutWatermarkKeepsTheLegacyBehaviour(t *testing.T) {
	db := openTestDB(t)
	insertRow(t, db, "only-row")
	duplicate(db, 0)
	if got := countRows(t, db); got != 2 {
		t.Fatalf("row count = %d, want 2", got)
	}
}
