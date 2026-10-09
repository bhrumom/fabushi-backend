"""Exercise Wrangler's filename order and applied-history behavior using real SQLite."""
from pathlib import Path
import sqlite3
import unittest

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / 'fabushi/web/migrations'
NAMES = sorted(path.name for path in MIGRATIONS.glob('*human_call*.sql'))
BASE = '20261005_human_call_signaling.sql'
CONVERGENCE = '20261005_human_call_convergence.sql'
DEVICE = '20261005_human_call_device_claim.sql'
BOOTSTRAP = '20261004_human_call_bootstrap.sql'


def apply(db, applied):
    for name in NAMES:
        if name not in applied:
            db.executescript((MIGRATIONS / name).read_text())
            applied.add(name)


def seed(db):
    db.execute("INSERT INTO human_call_channels(id,creator_user_id,peer_user_id,created_at,updated_at) VALUES ('existing',1,2,'before','before')")
    db.execute("INSERT INTO human_call_events VALUES ('existing',1,0,1,'device','event','signal','{}','before')")
    db.commit()


class CallMigrationUpgrade(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.db.execute('PRAGMA foreign_keys=ON')
        self.addCleanup(self.db.close)

    def assert_schema(self):
        columns = {row[1] for row in self.db.execute('PRAGMA table_info(human_call_channels)')}
        self.assertTrue({'state', 'creator_device_id', 'peer_device_id'} <= columns)
        self.assertEqual([], self.db.execute('PRAGMA foreign_key_check').fetchall())

    def assert_data(self):
        self.assertEqual(('existing', 1, 2, 'before'), self.db.execute('SELECT id,creator_user_id,peer_user_id,created_at FROM human_call_channels').fetchone())
        self.assertEqual(('existing', 1, '{}'), self.db.execute('SELECT call_id,seq,payload_json FROM human_call_events').fetchone())

    def test_missing_base_follows_real_filename_order(self):
        self.assertLess(NAMES.index(BOOTSTRAP), NAMES.index(CONVERGENCE))
        self.assertLess(NAMES.index(BOOTSTRAP), NAMES.index(DEVICE))
        applied = set()
        apply(self.db, applied)
        self.assert_schema()
        self.assertEqual(set(NAMES), applied)
        seed(self.db)
        apply(self.db, applied)
        self.assert_data()

    def test_existing_base_preserves_rows_and_history(self):
        self.db.executescript((MIGRATIONS / BASE).read_text())
        seed(self.db)
        applied = {BASE}
        apply(self.db, applied)
        self.assert_schema()
        self.assert_data()
        self.assertEqual('invited', self.db.execute('SELECT state FROM human_call_channels').fetchone()[0])
        self.assertEqual(set(NAMES), applied)

    def test_already_upgraded_only_runs_new_bootstrap(self):
        for name in (BASE, CONVERGENCE, DEVICE):
            self.db.executescript((MIGRATIONS / name).read_text())
        seed(self.db)
        self.db.execute("UPDATE human_call_channels SET state='active',creator_device_id='a',peer_device_id='b'")
        self.db.commit()
        applied = {BASE, CONVERGENCE, DEVICE}
        apply(self.db, applied)
        self.assert_schema()
        self.assert_data()
        self.assertEqual(('active','a','b'), self.db.execute('SELECT state,creator_device_id,peer_device_id FROM human_call_channels').fetchone())
        self.assertEqual(set(NAMES), applied)


if __name__ == '__main__':
    unittest.main(verbosity=2)
