process.env.NODE_ENV = "test";

if (!process.env.DATABASE_URL) {
  process.env.VITEST_SKIP_DB = "1";
}
