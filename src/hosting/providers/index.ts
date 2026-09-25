// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The complete set of provider constructors, the port of the `switch` in Go's
 * `providers.ClientFromProfile`.
 *
 * `ProviderRegistry` is deliberately `Partial` so that Phase 3 could land one
 * provider at a time and so that a test can inject a registry holding a single
 * fake. This module is the opposite end of that: it is typed as the *total*
 * `Record<ProviderKind, ProviderClientFactory>`, so adding a member to
 * `PROVIDER_KINDS` without registering its constructor here is a compile error
 * rather than a `provider_unsupported` failure discovered at runtime.
 *
 * Nothing here reads configuration, environment variables or credentials: the
 * `HostingClientFactory` owns all of that and hands each constructor a
 * provider-neutral `ProviderClientContext`.
 */

import type { ProviderKind } from "../../config/schema.js";
import type { ProviderClientFactory } from "../factory.js";
import { createCloudwaysClient } from "./cloudways.js";
import { createHostingerClient } from "./hostinger.js";
import { createInstaWpClient } from "./instawp.js";
import { createKinstaClient } from "./kinsta.js";
import { createPantheonClient } from "./pantheon.js";
import { createPressableClient } from "./pressable.js";
import { createPleskClient } from "./plesk.js";
import { createRocketNetClient } from "./rocketnet.js";
import { createWpEngineClient } from "./wpengine.js";

/**
 * Every supported provider, keyed by `ProviderKind`. Typed as the total record
 * on purpose: a provider missing from this map does not compile.
 */
export const PROVIDER_REGISTRY: Readonly<
  Record<ProviderKind, ProviderClientFactory>
> = {
  kinsta: createKinstaClient,
  instawp: createInstaWpClient,
  pantheon: createPantheonClient,
  pressable: createPressableClient,
  wpengine: createWpEngineClient,
  rocketnet: createRocketNetClient,
  hostinger: createHostingerClient,
  cloudways: createCloudwaysClient,
  plesk: createPleskClient,
};

export {
  createCloudwaysClient,
  createHostingerClient,
  createInstaWpClient,
  createKinstaClient,
  createPantheonClient,
  createPressableClient,
  createPleskClient,
  createRocketNetClient,
  createWpEngineClient,
};
