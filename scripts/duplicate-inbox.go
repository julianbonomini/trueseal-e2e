package main

import (
	"database/sql"
	"fmt"
	"strconv"
	"os"
	"time"

	_ "modernc.org/sqlite"
)

// duplicate-inbox manipulates the relay's SQLite inbox mid-test so the
// system suite can exercise duplicate delivery and crash windows.
//
// Watermark discipline (E3b): the inbox is at-least-once end to end. The
// sender's outbox pump may legitimately push the same envelope twice, and an
// earlier subtest can leave an un-acked row behind. Waiting for "any row"
// (count >= 1) can therefore be satisfied by the WRONG row, releasing the
// test before the envelope it actually sent has landed. Callers pass a
// watermark — the max row id from BEFORE the send — and only rows newer
// than the watermark count. Without a watermark the helper behaves as
// before (watermark 0).

func main() {
	if len(os.Args) < 3 || len(os.Args) > 4 {
		fmt.Fprintln(os.Stderr, "usage: duplicate-inbox <duplicate|wait-queued|wait-empty|max-id> <sqlite-path> [after-id]")
		os.Exit(2)
	}

	db, err := sql.Open("sqlite", os.Args[2])
	if err != nil {
		fatal(err)
	}
	defer db.Close()

	afterID := int64(0)
	if len(os.Args) == 4 {
		if _, err := fmt.Sscan(os.Args[3], &afterID); err != nil {
			fatal(fmt.Errorf("after-id must be an integer: %w", err))
		}
	}

	switch os.Args[1] {
	case "duplicate":
		duplicate(db, afterID)
	case "wait-queued":
		waitQueued(db, afterID, waitTimeout())
	case "wait-empty":
		waitEmpty(db, waitTimeout())
	case "max-id":
		fmt.Println(maxID(db))
	default:
		fatal(fmt.Errorf("unknown command %q", os.Args[1]))
	}
}

// maxID returns the largest row id in the inbox, or 0 when it is empty.
// Callers capture this BEFORE send() and pass it as the watermark, so only
// envelopes queued by that send are considered.
func maxID(db *sql.DB) int64 {
	var id sql.NullInt64
	if err := db.QueryRow(`SELECT MAX(id) FROM inbox`).Scan(&id); err != nil {
		fatal(err)
	}
	return id.Int64
}

// firstNewerThan returns the id of the oldest row newer than the watermark,
// or 0 when there is none. (An aggregate over an empty set yields NULL, not
// sql.ErrNoRows — hence the NullInt64.)
func firstNewerThan(db *sql.DB, afterID int64) (int64, error) {
	var id sql.NullInt64
	if err := db.QueryRow(`SELECT MIN(id) FROM inbox WHERE id > ?`, afterID).Scan(&id); err != nil {
		return 0, err
	}
	return id.Int64, nil
}

func duplicate(db *sql.DB, afterID int64) {
	// send() is durable-queue semantics since ADR-0026 (trueseal-sync#97):
	// the sender's outbox pump pushes asynchronously, so the envelope lands
	// in the relay inbox a beat after the send call returns. Wait for the
	// envelope NEWER than the watermark instead of assuming the push already
	// happened — and instead of counting rows, which leftovers (an un-acked
	// row from an earlier subtest) or a legitimate pump retry can inflate.
	deadline := time.Now().Add(10 * time.Second)
	var id int64
	for {
		var err error
		id, err = firstNewerThan(db, afterID)
		if err != nil {
			fatal(err)
		}
		if id != 0 {
			break
		}
		if time.Now().After(deadline) {
			fatal(fmt.Errorf("timed out waiting for an envelope newer than row %d", afterID))
		}
		time.Sleep(25 * time.Millisecond)
	}

	// Duplicate exactly that row. Extra rows (leftovers, a pump double-push)
	// are none of this helper's business: the relay may deliver N copies and
	// the library's Replay Window dedups them (ADR-0031) — the test asserts
	// one handling, not one inbox row.
	result, err := db.Exec(`
		INSERT INTO inbox (recipient, envelope, expires_at)
		SELECT recipient, envelope, expires_at FROM inbox WHERE id = ?
	`, id)
	if err != nil {
		fatal(err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		fatal(err)
	}
	if rows != 1 {
		fatal(fmt.Errorf("expected to duplicate row %d, duplicated %d", id, rows))
	}
}

// waitTimeout reads DUPLICATE_INBOX_TIMEOUT_S (default 10). Loaded
// suites (the full G1 matrix runs this helper after ~70 driver
// processes) can outlast 10 s on an honest path. An env var, not an
// arg, because wait-queued's optional after-id would be ambiguous.
func waitTimeout() time.Duration {
	if n, err := strconv.Atoi(os.Getenv("DUPLICATE_INBOX_TIMEOUT_S")); err == nil && n > 0 {
		return time.Duration(n) * time.Second
	}
	return 10 * time.Second
}

func waitQueued(db *sql.DB, afterID int64, timeout time.Duration) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		id, err := firstNewerThan(db, afterID)
		if err != nil {
			fatal(err)
		}
		if id != 0 {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	fatal(fmt.Errorf("no envelope newer than row %d reached the inbox before deadline", afterID))
}

func waitEmpty(db *sql.DB, timeout time.Duration) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		var count int
		if err := db.QueryRow(`SELECT COUNT(*) FROM inbox`).Scan(&count); err != nil {
			fatal(err)
		}
		if count == 0 {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	fatal(fmt.Errorf("inbox did not become empty before deadline"))
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
