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
		fmt.Fprintln(os.Stderr, "usage: duplicate-inbox <duplicate|wait-empty> <sqlite-path>")
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
	case "wait-empty":
		waitEmpty(db)
	default:
		fatal(fmt.Errorf("unknown command %q", os.Args[1]))
	}
}

func duplicate(db *sql.DB) {
	var before int
	if err := db.QueryRow(`SELECT COUNT(*) FROM inbox`).Scan(&before); err != nil {
		fatal(err)
	}
	if before != 1 {
		fatal(fmt.Errorf("expected exactly one queued envelope, found %d", before))
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
