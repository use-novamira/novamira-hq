#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { main } from "./main.js";
import { mcpMain } from "./mcp/main.js";

const argv = process.argv.slice(2);
if (argv[0] === "mcp") await mcpMain(argv.slice(1));
else process.exitCode = await main(argv);
