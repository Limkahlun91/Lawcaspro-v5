process.env.NODE_ENV = "test";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set for tests");
}
