# Claude Implementation Support: Neighbor Great Building Scanner

## Purpose
Implement a feature that:
1. Gets the list of a target player's Great Buildings.
2. Uses each building's `entity_id` plus the target `player_id` to call the construction endpoint.
3. Extracts buildings that currently have progress / contributions worth surfacing.

This file is derived from the reference payload notes and examples in `neighbors_command.txt`.

---

## What the reference establishes

### 1) Initial request to get another player's Great Building overview
Use the following request pattern to retrieve a player's Great Buildings overview:

```json
[{"__class__":"ServerRequest","requestData":[853037541],"requestClass":"GreatBuildingsService","requestMethod":"getOtherPlayerOverview","requestId":23}]
```

The notes explicitly say this is the first step for getting the list of neighbors / target-player Great Buildings.

### 2) Overview response includes Great Building rows
The example response shows rows like:

```json
{
  "player": {
    "player_id": 13726603,
    "name": "Nick the Silver Fox",
    "avatar": "portrait_id_16",
    "__class__": "OtherPlayer"
  },
  "entity_id": 729,
  "city_entity_id": "X_PostModernEra_Landmark1",
  "name": "Cape Canaveral",
  "level": 70,
  "max_progress": 3969,
  "__class__": "GreatBuildingContributionRow"
}
```

From this, the important fields for follow-up calls are:
- `player.player_id`
- `entity_id`
- `name`
- `level`
- `max_progress`
- `city_entity_id`

### 3) Follow-up request per Great Building
The notes then explicitly say:

> for each of the great buildings that have current progress, we need to instantiate the getconstruction method

and provide this request pattern:

```json
[{"__class__":"ServerRequest","requestData":[6027,13726603],"requestClass":"GreatBuildingsService","requestMethod":"getConstruction","requestId":20}]
```

The notes also explicitly define the request data format:

```text
[entity_id, player_id]
```

and say:

```text
entity id is the unique id of the great building for that player
```

### 4) Transport details
The notes also state:
- query string parameter `h` is passed in
- string `id` value is passed in

So the implementation should preserve whatever existing request transport your app already uses for `h` and `id` when calling these server endpoints.

---

## Important implementation interpretation
The reference is clear about the call sequence, but it does **not** fully document the shape of the `getConstruction` response. Because of that:

1. Treat `getOtherPlayerOverview` as the discovery call.
2. Treat `getConstruction` as the detail call.
3. Inspect the actual `getConstruction` payload in code and extract the fields that represent:
   - current progress
   - max progress if present there too
   - existing contributions / contributor rows
   - available spots / rank / rewards if present
4. Do **not** hardcode an assumed `getConstruction` response shape unless you already have a captured sample elsewhere.

In other words: the implementation should be resilient and log unknown response shapes the first time it sees them.

---

## Recommended implementation plan

### Step 1: Accept a target player id
Your function should start with a target player id, for example:

```ts
const targetPlayerId = 13726603;
```

### Step 2: Call `getOtherPlayerOverview`
Build the payload:

```json
[
  {
    "__class__": "ServerRequest",
    "requestData": [13726603],
    "requestClass": "GreatBuildingsService",
    "requestMethod": "getOtherPlayerOverview",
    "requestId": 1
  }
]
```

> Note: the reference example uses `853037541` as the input id. Your implementation should treat that value as the target player identifier used by this endpoint.

### Step 3: Parse Great Building rows
From the response, collect every object where:

```text
__class__ === "GreatBuildingContributionRow"
```

Normalize each row into something like:

```ts
interface GreatBuildingOverviewRow {
  playerId: number;
  playerName: string;
  entityId: number;
  cityEntityId: string;
  name: string;
  level: number;
  maxProgress: number | null;
}
```

### Step 4: For each building, call `getConstruction`
For each row, build:

```json
[
  {
    "__class__": "ServerRequest",
    "requestData": [entityId, playerId],
    "requestClass": "GreatBuildingsService",
    "requestMethod": "getConstruction",
    "requestId": <incrementing number>
  }
]
```

### Step 5: Extract current-progress buildings
Because the exact response schema is not documented in the reference, implement a tolerant extractor that looks for fields such as:
- `current_progress`
- `currentProgress`
- `progress`
- `forge_points`
- `invested_forge_points`
- `contributions`
- `rankings`
- `reward`

If one of these exists and indicates non-zero / active progress, include the building in the result set.

### Step 6: Return a clean normalized object
Recommended normalized output:

```ts
interface GreatBuildingConstructionSummary {
  playerId: number;
  playerName: string;
  entityId: number;
  name: string;
  level: number;
  maxProgressFromOverview: number | null;
  currentProgress: number | null;
  hasProgress: boolean;
  rawConstruction: unknown;
}
```

---

## Strong implementation rules for Claude

### Rule 1: Separate discovery from detail
Do **not** try to infer current contribution state from the overview call alone. The overview is for listing buildings; the construction call is the detail lookup.

### Rule 2: Preserve transport/session behavior
Do not redesign auth/session handling. Reuse the app's existing logic for:
- cookies
- headers
- query parameters
- `h`
- `id`
- request batching if already present

### Rule 3: Make parsing defensive
The payloads are game-internal and may vary. Use optional chaining, guard clauses, and logging.

### Rule 4: Keep raw payloads available for debugging
Return or log the raw `getConstruction` payload during initial implementation so schema mapping can be refined quickly.

### Rule 5: Make request ids deterministic
Use incrementing `requestId` values per batched request. They do not appear to be the business identifier.

---

## Suggested pseudocode

```ts
async function getNeighborGreatBuildingsWithProgress(playerId: number) {
  const overviewPayload = [{
    __class__: "ServerRequest",
    requestData: [playerId],
    requestClass: "GreatBuildingsService",
    requestMethod: "getOtherPlayerOverview",
    requestId: 1,
  }];

  const overviewResponse = await postGameRequest(overviewPayload, { h, id });

  const rows = extractGreatBuildingRows(overviewResponse);

  const results = [];

  let requestId = 2;
  for (const row of rows) {
    const constructionPayload = [{
      __class__: "ServerRequest",
      requestData: [row.entityId, row.playerId],
      requestClass: "GreatBuildingsService",
      requestMethod: "getConstruction",
      requestId: requestId++,
    }];

    const constructionResponse = await postGameRequest(constructionPayload, { h, id });
    const currentProgress = extractCurrentProgress(constructionResponse);

    results.push({
      playerId: row.playerId,
      playerName: row.playerName,
      entityId: row.entityId,
      name: row.name,
      level: row.level,
      maxProgressFromOverview: row.maxProgress,
      currentProgress,
      hasProgress: typeof currentProgress === "number" ? currentProgress > 0 : false,
      rawConstruction: constructionResponse,
    });
  }

  return results.filter(x => x.hasProgress);
}
```

---

## Suggested extractor helpers

```ts
function extractGreatBuildingRows(response: unknown): GreatBuildingOverviewRow[] {
  const items = Array.isArray(response) ? response : [];
  const rows: GreatBuildingOverviewRow[] = [];

  for (const item of items) {
    const responseData = (item as any)?.responseData;
    if (!Array.isArray(responseData)) continue;

    for (const row of responseData) {
      if (row?.__class__ !== "GreatBuildingContributionRow") continue;
      rows.push({
        playerId: Number(row?.player?.player_id ?? 0),
        playerName: String(row?.player?.name ?? ""),
        entityId: Number(row?.entity_id ?? 0),
        cityEntityId: String(row?.city_entity_id ?? ""),
        name: String(row?.name ?? ""),
        level: Number(row?.level ?? 0),
        maxProgress: row?.max_progress == null ? null : Number(row.max_progress),
      });
    }
  }

  return rows.filter(r => r.playerId && r.entityId);
}

function extractCurrentProgress(response: unknown): number | null {
  const visited = new Set<any>();

  function walk(node: any): number | null {
    if (!node || typeof node !== "object") return null;
    if (visited.has(node)) return null;
    visited.add(node);

    const candidateKeys = [
      "current_progress",
      "currentProgress",
      "progress",
      "forge_points",
      "invested_forge_points",
    ];

    for (const key of candidateKeys) {
      if (typeof node[key] === "number") return node[key];
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        const found = walk(item);
        if (found != null) return found;
      }
      return null;
    }

    for (const value of Object.values(node)) {
      const found = walk(value);
      if (found != null) return found;
    }

    return null;
  }

  return walk(response);
}
```

---

## Edge cases Claude should handle
- Target player has no Great Buildings.
- `getOtherPlayerOverview` returns unrelated response objects before the building rows.
- Some rows may be malformed or missing `player.player_id`.
- `getConstruction` may fail for some buildings; continue processing others.
- Current progress may be absent even when the building exists.
- The endpoint may return batched response arrays with multiple service responses mixed together.

---

## What not to assume
- Do not assume `requestId` has to match the sample values exactly.
- Do not assume the overview response only contains Great Building rows.
- Do not assume `max_progress` from overview equals the live construction max in all cases.
- Do not assume the `getConstruction` schema until verified from a real response.

---

## Preferred final deliverable from Claude
Claude should implement:
1. A reusable `getOtherPlayerOverview(playerId)` function.
2. A reusable `getConstruction(entityId, playerId)` function.
3. A parser that extracts `GreatBuildingContributionRow` records.
4. A normalized result model for buildings with current progress.
5. Error-tolerant logging around unknown construction response shapes.
6. Minimal comments explaining the request sequence and why both calls are needed.

---

## Source note
This guidance is based on the reference notes that show:
- `getOtherPlayerOverview` as the first call,
- `GreatBuildingContributionRow` objects containing `entity_id` and `player.player_id`, and
- `getConstruction` using `[entity_id, player_id]` as request data.
