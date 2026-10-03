import { defaultSqlPreferences } from "../shared/contracts.js";
import type {
  SqlPreferences,
  SqlQuery,
  SqlTable,
} from "../shared/contracts.js";

const TABLES: SqlTable[] = [
  {
    name: "users",
    schema: "public",
    rowCount: 15420,
    description: "Application user accounts",
    columns: [
      { name: "id", type: "uuid", nullable: false, isPrimary: true },
      { name: "email", type: "text", nullable: false, isPrimary: false },
      { name: "name", type: "text", nullable: true, isPrimary: false },
      {
        name: "created_at",
        type: "timestamptz",
        nullable: false,
        isPrimary: false,
      },
      {
        name: "last_login",
        type: "timestamptz",
        nullable: true,
        isPrimary: false,
      },
    ],
  },
  {
    name: "orders",
    schema: "public",
    rowCount: 89340,
    description: "Customer orders",
    columns: [
      { name: "id", type: "uuid", nullable: false, isPrimary: true },
      { name: "user_id", type: "uuid", nullable: false, isPrimary: false },
      {
        name: "total",
        type: "numeric(10,2)",
        nullable: false,
        isPrimary: false,
      },
      { name: "status", type: "text", nullable: false, isPrimary: false },
      {
        name: "created_at",
        type: "timestamptz",
        nullable: false,
        isPrimary: false,
      },
    ],
  },
  {
    name: "products",
    schema: "public",
    rowCount: 1240,
    description: "Product catalog",
    columns: [
      { name: "id", type: "uuid", nullable: false, isPrimary: true },
      { name: "name", type: "text", nullable: false, isPrimary: false },
      {
        name: "price",
        type: "numeric(10,2)",
        nullable: false,
        isPrimary: false,
      },
      { name: "category", type: "text", nullable: true, isPrimary: false },
      { name: "in_stock", type: "boolean", nullable: false, isPrimary: false },
    ],
  },
  {
    name: "events",
    schema: "analytics",
    rowCount: 2340000,
    description: "Analytics event stream",
    columns: [
      { name: "id", type: "bigserial", nullable: false, isPrimary: true },
      { name: "event_type", type: "text", nullable: false, isPrimary: false },
      { name: "user_id", type: "uuid", nullable: true, isPrimary: false },
      { name: "properties", type: "jsonb", nullable: true, isPrimary: false },
      {
        name: "timestamp",
        type: "timestamptz",
        nullable: false,
        isPrimary: false,
      },
    ],
  },
  {
    name: "sessions",
    schema: "analytics",
    rowCount: 45600,
    description: "User sessions",
    columns: [
      { name: "id", type: "uuid", nullable: false, isPrimary: true },
      { name: "user_id", type: "uuid", nullable: false, isPrimary: false },
      {
        name: "started_at",
        type: "timestamptz",
        nullable: false,
        isPrimary: false,
      },
      {
        name: "ended_at",
        type: "timestamptz",
        nullable: true,
        isPrimary: false,
      },
      { name: "ip_address", type: "inet", nullable: true, isPrimary: false },
    ],
  },
];

const QUERIES: SqlQuery[] = [
  {
    sql: "SELECT * FROM users WHERE created_at > NOW() - INTERVAL '30 days' ORDER BY created_at DESC",
    tables: ["users"],
    description: "Recent user signups",
  },
  {
    sql: "SELECT status, COUNT(*) as count, SUM(total) as revenue FROM orders GROUP BY status ORDER BY count DESC",
    tables: ["orders"],
    description: "Order status breakdown",
  },
  {
    sql: "SELECT date_trunc('day', timestamp) as day, COUNT(*) as events FROM events WHERE timestamp > NOW() - INTERVAL '7 days' GROUP BY day ORDER BY day",
    tables: ["events"],
    description: "Daily event volume",
  },
  {
    sql: "SELECT u.name, COUNT(o.id) as order_count, SUM(o.total) as total_spent FROM users u JOIN orders o ON o.user_id = u.id GROUP BY u.name ORDER BY total_spent DESC LIMIT 10",
    tables: ["users", "orders"],
    description: "Top customers by spend",
  },
];

export interface SqlStore {
  listTables(): Promise<SqlTable[]>;
  getTable(name: string): Promise<SqlTable | undefined>;
  searchTables(query: string): Promise<SqlTable[]>;
  listQueries(): Promise<SqlQuery[]>;
  readSettings(): Promise<SqlPreferences>;
  updateSettings(prefs: Partial<SqlPreferences>): Promise<SqlPreferences>;
}

export function createSqlStore(): SqlStore {
  let preferences: SqlPreferences = { ...defaultSqlPreferences };

  return {
    async listTables() {
      return TABLES;
    },
    async getTable(name: string) {
      return TABLES.find((t) => t.name === name);
    },
    async searchTables(query: string) {
      const q = query.trim().toLowerCase();
      if (!q) return TABLES;
      return TABLES.filter(
        (t) =>
          t.name.includes(q) ||
          t.description?.toLowerCase().includes(q) ||
          t.columns.some((c) => c.name.includes(q)),
      );
    },
    async listQueries() {
      return QUERIES;
    },
    async readSettings() {
      return preferences;
    },
    async updateSettings(prefs: Partial<SqlPreferences>) {
      preferences = { ...preferences, ...prefs };
      return preferences;
    },
  };
}
