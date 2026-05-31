// Mock global fetch for all tests to prevent hitting local API endpoints during test runs
global.fetch = jest.fn().mockImplementation(() => Promise.resolve({
  ok: true,
  json: () => Promise.resolve({})
}));
