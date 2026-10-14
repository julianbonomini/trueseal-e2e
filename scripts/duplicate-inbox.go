package main

import (
	"database/sql"
	"fmt"
	"os"
	"time"

	_ "modernc.org/sqlite"
)

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: duplicate-inbox <duplicate|wait-queued|wait-empty> <sqlite-path>")
		os.Exit(2)
	}

	db, err := sql.Open("sqlite", os.Args[2])
	if err != nil {
		fatal(err)
	}
	defer db.Close()

	switch os.Args[1] {
	case "duplicate":
		duplicate(db)
	case "wait-queued":
		waitQueued(db)
	case "wait-empty":
		waitEmpty(db)
	default:
		fatal(fmt.Errorf("unknown command %q", os.Args[1]))
	}
}

func duplicate(db *sql.DB) {
	// send() is durable-queue semantics since ADR-0026 (trueseal-sync#97):
	// the sender's outbox pump pushes asynchronously, so the envelope lands
	// in the relay inbox a beat after the send call returns. Wait for it
	// instead of assuming the push already happened.
	deadline := time.Now().Add(10 * time.Second)
	for {
		var before int
		if err := db.QueryRow(`SELECT COUNT(*) FROM inbox`).Scan(&before); err != nil {
			fatal(err)
		}
		if before == 1 {
			break
		}
		if before > 1 {
			fatal(fmt.Errorf("expected exactly one queued envelope, found %d", before))
		}
		if time.Now().After(deadline) {
			fatal(fmt.Errorf("timed out waiting for the queued envelope (found %d)", before))
		}
		time.Sleep(25 * time.Millisecond)
	}

	result, err := db.Exec(`
		INSERT INTO inbox (recipient, envelope, expires_at)
		SELECT recipient, envelope, expires_at FROM inbox LIMIT 1
	`)
	if err != nil {
		fatal(err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		fatal(err)
	}
	if rows != 1 {
		fatal(fmt.Errorf("expected to duplicate one envelope, duplicated %d", rows))
	}
}

func waitQueued(db *sql.DB) {
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		var count int
		if err := db.QueryRow(`SELECT COUNT(*) FROM inbox`).Scan(&count); err != nil {
			fatal(err)
		}
		if count >= 1 {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	fatal(fmt.Errorf("no envelope reached the inbox before deadline"))
}

func waitEmpty(db *sql.DB) {
	deadline := time.Now().Add(5 * time.Second)
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
