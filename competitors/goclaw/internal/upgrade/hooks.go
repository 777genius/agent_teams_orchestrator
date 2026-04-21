package upgrade

// Data migration hooks are registered here.
// Add new hooks when a schema migration requires Go-based data transformation.
//
// Example:
//
//	func init() {
//		RegisterDataHook(8, "008_backfill_agent_slugs", func(ctx context.Context, db *sql.DB) error {
//			// transform data after migration 000008 is applied
//			return nil
//		})
//	}
