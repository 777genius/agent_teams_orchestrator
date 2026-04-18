package pg

import (
	"database/sql"
	"fmt"
	"log/slog"

	_ "github.com/jackc/pgx/v5/stdlib"
)

// OpenDB creates a database/sql connection to Postgres using pgx driver.
func OpenDB(dsn string) (*sql.DB, error) {
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return nil, fmt.Errorf("open postgres: %w", err)
	}

	db.SetMaxOpenConns(25)
	db.SetMaxIdleConns(10)

	if err := db.Ping(); err != nil {
		db.Close()
		return nil, fmt.Errorf("ping postgres: %w", err)
	}

	slog.Info("postgres connected", "dsn_len", len(dsn))
	return db, nil
}
