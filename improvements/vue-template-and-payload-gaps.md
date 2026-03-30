# Code Graph Gaps: Field-Level Detail for Frontend Components

## Problem

When generating a functional ontology (Persona > Outcome > Scenario > Step > Action) from the code graph, we can extract ~80% of the required data. The remaining ~20% — specifically **field-level UI details** and **full API payload structures** — is not available in the code graph due to two limitations.

---

## Gap 1: Vue/React Template Not Parsed

### What's missing

The `<template>` block in Vue SFCs (and JSX in React) contains the UI structure — form labels, field types, conditional rendering, section groupings — that directly maps to Steps and Actions in the functional ontology.

Example from `PurchaseSaleOrder.vue`:

```html
<b-form-group label="No." label-class="required">
  <b-form-input v-model="form.psOrder.no" required />
</b-form-group>

<b-form-group label="Credit Period">
  <b-form-input v-model="form.creditPeriod" type="number" />
</b-form-group>

<b-form-group :label="saleFlag ? 'Dispatch From' : 'Dispatch To'" v-if="config.godown">
  <v-select v-model="form.godown" :options="options.godowns" />
</b-form-group>
```

This tells us:
- **Field label**: "No.", "Credit Period", "Dispatch From"/"Dispatch To"
- **Field type**: text input, number input, select dropdown
- **Required/optional**: `required` attribute, `label-class="required"`
- **Conditional visibility**: `v-if="config.godown"`, `v-if="saleFlag"`
- **Data binding**: `v-model="form.psOrder.no"` — which data field this maps to
- **Section grouping**: `<b-card>` titles define logical sections (Steps)

### What the code graph has instead

The `<script>` block is fully parsed, giving us:
- Function names and call chains
- Import relationships (component tree)
- API calls with endpoints
- `data()` return structure (truncated at 200 chars)

But without the template, we cannot determine:
- What the user **sees** (labels, section titles)
- What fields are **conditionally shown** (sale vs purchase variants)
- What fields are **required** vs optional
- How fields are **grouped into sections** (which maps to Steps)

### Impact on functional ontology

| Ontology Level | Template provides | Without template |
|---|---|---|
| Step names | Card/section titles ("Transport Details", "Payment Details") | Must guess from component names |
| Action names | Form field labels ("Enter vehicle number", "Select transport mode") | Must guess from data field names |
| Action conditions | `v-if` directives ("shown only for Road transport") | Not available |
| Required fields | `required` attribute | Not available |
| Scenario variants | `v-if="saleFlag"` reveals sale vs purchase differences | Only `isSale` computed property visible |

### Possible solutions

1. **Parse `<template>` in the Vue parser** — extract `<b-form-group>` labels, `v-model` bindings, `v-if` conditions, and `<b-card>` section titles as additional metadata
2. **Store template as raw text** — add a `template` field to the file output so downstream LLMs can read it directly
3. **Accept the gap** — use the `<script>` data for 80% coverage and supplement with document/screenshot analysis for the remaining 20%

---

## Gap 2: Lexical Declaration Truncation (200 chars)

### What's missing

When a function builds an API payload as a `const`/`let` object, the statement text is truncated at 200 characters. This cuts off field names that appear later in the object.

Example from `PurchaseSaleOrder.vue`, `initPayload()` function:

```js
let orderData = {
  orderno: this.form.psOrder.no,           // ← captured (within 200 chars)
  orderdate: this.form.psOrder.date,       // ← captured
  creditperiod: this.form.psOrder.creditPeriod, // ← captured
  payterms: this.form.psOrder.terms,       // ← captured
  sourcestate: this.form.psOrder.state.name,    // ← NOT captured (beyond 200 chars)
  orgstategstin: this.form.psOrder.gstin,       // ← NOT captured
  roundoffflag: this.form.total.roundFlag,      // ← NOT captured
  paymentmode: this.form.payment.mode,          // ← NOT captured
  modeoftransport: this.form.transport.mode,    // ← NOT captured
  reversecharge: this.form.transport.reverseCharge, // ← NOT captured
  vehicleno: this.form.transport.vno,           // ← NOT captured
  dateofsupply: this.form.transport.date,       // ← NOT captured
  bankdetails: { accountno, bankname, ifsc },   // ← NOT captured
  purchaseordertotal: this.form.total.amount,   // ← NOT captured
  ...
};
```

The full `orderData` declaration is **930 characters**. At the current 200-char limit, only the first 4 fields are visible in the code graph. The remaining 12 fields — including critical ones like `sourcestate`, `transportationmode`, `reversecharge`, `bankdetails` — are lost.

### Measured sizes for common payload patterns

| Pattern | Typical size | At 200 chars | At 500 chars | At 1000 chars |
|---|---|---|---|---|
| Small variable (`let x = 0`) | 10-30 chars | Full | Full | Full |
| URL construction (`const url = ...`) | 50-100 chars | Full | Full | Full |
| Config object (`const config = {...}`) | 200-500 chars | Partial | Full | Full |
| API payload (`let orderData = {...}`) | 500-1500 chars | 4/16 fields | 7/16 fields | 16/16 fields |
| Function assignment (`const fn = () => {...}`) | 100-5000 chars | Truncated | Truncated | Truncated |

### Impact on functional ontology

The API payload object is the **single most important data structure** for functional ontology generation because it lists every field the user provides. Missing fields = missing Actions in the ontology.

For the Purchase/Sale Order example:
- At 200 chars: 4 of 16 fields visible → 25% of Actions derivable from payload
- At 1000 chars: 16 of 16 fields visible → 100% of Actions derivable from payload

### Why not just increase the limit?

Increasing the truncation limit has trade-offs:
- **Storage**: Each statement is stored in Neo4j. 200 → 1000 = 5x more text per statement. With thousands of statements across a codebase, this adds up.
- **Embedding quality**: Statement text is used for semantic search embeddings. Longer text may dilute the embedding signal.
- **Function assignments**: `const foo = async () => { entire function body }` would capture large function bodies as statement text, duplicating what's already in `functions[]`.
- **Noise ratio**: Most `lexical_declaration` statements are small (under 100 chars). The payload objects that benefit from higher limits are a minority.

### Possible solutions

1. **Selective increase** — only increase the limit for object literals (`{...}`) and array literals (`[...]`), not function assignments
2. **Structured extraction** — instead of truncating raw text, parse the object keys and store them as a list: `["orderno", "orderdate", "creditperiod", "payterms", "sourcestate", ...]`
3. **Payload detection** — detect when a `lexical_declaration` assigns an object that is later passed to an API call, and capture it with a higher limit (e.g. 2000 chars)
4. **Keep current limit** — accept the truncation and rely on the `calls[]` array + API endpoints for downstream processing

---

## Combined Impact

For the PurchaseSaleOrder deep dive, these two gaps together account for the missing 20%:

| What we need | Source | Available in graph? |
|---|---|---|
| Component tree (10 children) | `<script>` imports | Yes — 100% |
| API endpoints (4 main + 14 child) | `<script>` function calls + api_call statements | Yes — 100% |
| Functions (25 total) | `<script>` method definitions | Yes — 100% |
| Payload fields (16 fields) | `<script>` lexical_declaration | Partial — 25% (truncation) |
| Form labels (20+ fields) | `<template>` form groups | No — 0% (not parsed) |
| Section titles (8 sections) | `<template>` card headers | No — 0% (not parsed) |
| Conditional rendering (sale/purchase) | `<template>` v-if directives | No — 0% (not parsed) |
| Required/optional markers | `<template>` required attribute | No — 0% (not parsed) |
