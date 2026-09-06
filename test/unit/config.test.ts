import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/config.js";

describe("loadConfig", () => {
  it("defaults to a local instance and sane thresholds", () => {
    const config = loadConfig({});
    expect(config.n8nUrl).toBe("http://localhost:5678");
    expect(config.stuckThresholdMinutes).toBe(15);
    expect(config.dbWarnBytes).toBe(1024 ** 3);
    expect(config.n8nApiKey).toBeUndefined();
  });

  it("strips trailing slashes so URL joining stays predictable", () => {
    expect(loadConfig({ N8N_URL: "https://n8n.example.com///" }).n8nUrl).toBe("https://n8n.example.com");
  });

  it("treats blank values as unset", () => {
    const config = loadConfig({ N8N_API_KEY: "   ", N8N_GIT_REPO_PATH: "", N8N_GUARD_STUCK_MINUTES: "" });
    expect(config.n8nApiKey).toBeUndefined();
    expect(config.gitRepoPath).toBeUndefined();
    expect(config.stuckThresholdMinutes).toBe(15);
  });

  it("rejects an unusable URL instead of failing later at request time", () => {
    expect(() => loadConfig({ N8N_URL: "not a url" })).toThrow(ConfigError);
  });

  it("rejects non-positive numeric settings", () => {
    expect(() => loadConfig({ N8N_GUARD_STUCK_MINUTES: "0" })).toThrow(ConfigError);
    expect(() => loadConfig({ N8N_GUARD_TIMEOUT_MS: "abc" })).toThrow(ConfigError);
  });

  it("carries every configurable path through", () => {
    const config = loadConfig({
      N8N_URL: "http://n8n:5678",
      N8N_API_KEY: "key",
      N8N_SQLITE_PATH: "/data/database.sqlite",
      N8N_GIT_REPO_PATH: "/repo",
      N8N_GUARD_STUCK_MINUTES: "45",
    });
    expect(config).toMatchObject({
      n8nUrl: "http://n8n:5678",
      n8nApiKey: "key",
      sqlitePath: "/data/database.sqlite",
      gitRepoPath: "/repo",
      stuckThresholdMinutes: 45,
    });
  });
});
