process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://plattform:plattform_dev@localhost:5432/plattform_test';
