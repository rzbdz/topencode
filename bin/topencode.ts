#!/usr/bin/env bun
import { setProfile } from "../src/profile.ts";
import { opencodeProfile } from "../src/products/opencode/profile.ts";
import { main } from "../src/cli.ts";

// The product must be selected before any engine code runs: the shared tmux
// driver, dashboard and CLI read the profile lazily, so this is the one line
// that decides whether this process is topencode or tclaude.
setProfile(opencodeProfile);

await main();
