/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  moduleFileExtensions: ["ts", "js", "json"],
  moduleNameMapper: {
    "src/(.*)": "<rootDir>/src/$1"
  },
  globals: {
    "ts-jest": {
      isolatedModules: true
    }
  }
};