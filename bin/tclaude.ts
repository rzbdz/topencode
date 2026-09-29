#!/usr/bin/env bun
import { setProfile } from "../src/profile.ts";
import { claudeProfile } from "../src/products/claude/profile.ts";
import { main } from "../src/cli.ts";

// tclaude is the same engine as topencode over Claude Code's own session store.
// It compiles to its own binary and installs to its own path, so the two can be
// updated independently and run side by side (separate tmux sessions, separate
// @tc_* window options).
setProfile(claudeProfile);

await main();
