import type { JestConfigWithTsJest } from "ts-jest";

const config: JestConfigWithTsJest = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  moduleFileExtensions: ["ts", "js", "json"],
  moduleNameMapper: {
    "^@services/(.*)$": "<rootDir>/src/services/$1",
    "^@middlewares/(.*)$": "<rootDir>/src/middlewares/$1",
    "^@config/(.*)$": "<rootDir>/src/config/$1",
    "^@graphql/(.*)$": "<rootDir>/src/graphql/$1",
    "^@utils/(.*)$": "<rootDir>/src/utils/$1"
  },
  globals: {
    "ts-jest": {
      isolatedModules: true,
      tsconfig: "tsconfig.test.json"
    }
  }
};

export default config;