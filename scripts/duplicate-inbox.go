package main

import (
	"database/sql"
	"fmt"
	"os"

	_ "modernc.org/sqlite"
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: duplicate-inbox <sqlite-path>")
		os.Exit(2)
	}

	db, err := sql.Open("sqlite", os.Args[1])
	if err != nil {
		fatal(err)
	}
	defer db.Close()

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

func fatal(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
