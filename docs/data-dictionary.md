# Data dictionary

Generated from the Mongoose models by `npm run data-dictionary -w server`. Do not edit by hand.

**PII** marks personal data under RA 10173: never in fixtures, logs or git; masked in the audit
log (ADR-0006); hidden from roles without `view_personal_data`.

Documents have a UUID string `_id`. Most also have `createdAt`, `updatedAt`, `createdBy`,
`updatedBy`, `isDeleted`, `deletedAt` and `deletedBy` (soft delete, ADR-0006), which are not
repeated below. A field ending in `Id` holds the `_id` of another document: MongoDB does not
enforce these, so the services do, and `npm run integrity -w server` checks them.

## `association_members`

| Field | Type | Required | PII | Notes |
|---|---|---|---|---|
| `associationId` | String | yes |  |  |
| `farmerId` | String | yes |  |  |
| `role` | String |  |  | at most 60 characters |
| `since` | Date |  |  |  |

Indexes: `farmerId, associationId` (unique)

## `associations`

| Field | Type | Required | PII | Notes |
|---|---|---|---|---|
| `municipalityId` | String | yes |  |  |
| `name` | String | yes |  | at most 200 characters |
| `normalizedName` | String | yes |  |  |
| `registrationBody` | String |  |  | at most 100 characters |
| `registrationNo` | String |  |  | at most 60 characters |
| `shortName` | String |  |  | at most 50 characters |
| `type` | String |  |  | one of: farmers_association, cooperative, irrigators_association, other |

Indexes: `municipalityId, normalizedName` (unique)

## `audit_logs`

| Field | Type | Required | PII | Notes |
|---|---|---|---|---|
| `action` | String | yes |  |  |
| `actorId` | String |  |  |  |
| `after` | Mixed |  |  |  |
| `before` | Mixed |  |  |  |
| `ip` | String |  |  |  |
| `objectId` | String |  |  |  |
| `objectType` | String |  |  |  |
| `userAgent` | String |  |  |  |

Indexes: `objectType, objectId, createdAt`

## `barangays`

| Field | Type | Required | PII | Notes |
|---|---|---|---|---|
| `boundary` | Mixed |  |  | left out of queries unless asked for |
| `isVerified` | Boolean |  |  |  |
| `municipalityId` | String | yes |  |  |
| `name` | String | yes |  |  |
| `normalizedName` | String | yes |  |  |
| `psgcCode` | String |  |  | unique |

Indexes: `municipalityId, normalizedName` (unique)

## `commodities`

| Field | Type | Required | PII | Notes |
|---|---|---|---|---|
| `attributesSchema` | Mixed |  |  |  |
| `code` | String | yes |  | at most 30 characters; unique |
| `measureType` | String | yes |  | one of: trees, area |
| `name` | String | yes |  | at most 100 characters |
| `outlierMultiplier` | Decimal128 | yes |  |  |
| `plantsPerHa` | Number |  |  |  |
| `programId` | String | yes |  |  |
| `spacingM` | Decimal128 |  |  |  |

## `crop_stands`

| Field | Type | Required | PII | Notes |
|---|---|---|---|---|
| `attributes` | Mixed |  |  |  |
| `barangayId` | String | yes |  |  |
| `commodityId` | String | yes |  |  |
| `farmId` | String | yes |  |  |
| `municipalityId` | String | yes |  |  |
| `programId` | String | yes |  |  |
| `spacingM` | Decimal128 |  |  |  |

Indexes: `farmId, commodityId` (unique)

## `farmers`

| Field | Type | Required | PII | Notes |
|---|---|---|---|---|
| `birthYear` | Number |  | **PII** |  |
| `consentAt` | Date |  |  |  |
| `consentById` | String |  |  |  |
| `contactNo` | String |  | **PII** | at most 40 characters |
| `firstName` | String |  | **PII** | at most 100 characters |
| `fullNameRaw` | String |  | **PII** | at most 300 characters |
| `homeBarangayId` | String | yes |  |  |
| `lastName` | String |  | **PII** | at most 100 characters |
| `mergedIntoId` | String |  |  |  |
| `middleName` | String |  | **PII** | at most 100 characters |
| `municipalityId` | String | yes |  |  |
| `normalizedName` | String |  | **PII** |  |
| `rsbsaNo` | String |  | **PII** | at most 40 characters; unique |
| `sex` | String |  | **PII** | one of: , male, female |
| `status` | String |  |  | one of: active, inactive, needs_review |
| `suffix` | String |  | **PII** | at most 20 characters |

Indexes: `municipalityId, normalizedName`

## `farms`

| Field | Type | Required | PII | Notes |
|---|---|---|---|---|
| `barangayId` | String | yes |  |  |
| `declaredAreaHa` | Decimal128 |  |  |  |
| `farmerId` | String | yes |  |  |
| `location` | Object |  | **PII** |  |
| `locationRaw` | String |  | **PII** |  |
| `municipalityId` | String | yes |  |  |
| `sitio` | String |  | **PII** | at most 100 characters |
| `tenure` | String |  |  | one of: , owner, tenant, lessee, arb, other |

## `growth_stages`

| Field | Type | Required | PII | Notes |
|---|---|---|---|---|
| `aliases` | Array of Mixed |  |  |  |
| `code` | String | yes |  | at most 30 characters |
| `commodityId` | String | yes |  |  |
| `isBearing` | Boolean |  |  |  |
| `label` | String | yes |  | at most 100 characters |
| `sortOrder` | Number | yes |  |  |

Indexes: `commodityId, code` (unique); `commodityId, sortOrder` (unique)

## `harvests`

| Field | Type | Required | PII | Notes |
|---|---|---|---|---|
| `barangayId` | String | yes |  |  |
| `buyer` | String |  |  | at most 150 characters |
| `cropStandId` | String | yes |  |  |
| `dateEstimated` | Boolean |  |  |  |
| `harvestDate` | Date |  |  |  |
| `municipalityId` | String | yes |  |  |
| `pricePerUnit` | Decimal128 |  |  |  |
| `productForm` | String |  |  | one of: wet_beans, dried_beans, pods, unknown |
| `programId` | String | yes |  |  |
| `quantity` | Decimal128 | yes |  |  |
| `rawText` | String |  |  |  |
| `unit` | String | yes |  | one of: kg, sack, other |

## `import_jobs`

| Field | Type | Required | PII | Notes |
|---|---|---|---|---|
| `asOfDate` | Date |  |  |  |
| `committedAt` | Date |  |  |  |
| `committedById` | String |  |  |  |
| `commodityId` | String |  |  |  |
| `errorMessage` | String |  |  |  |
| `errorReportPath` | String |  |  |  |
| `filePath` | String |  |  |  |
| `fileSha256` | String | yes |  |  |
| `fileSize` | Number |  |  |  |
| `filesPurgedAt` | Date |  |  |  |
| `kind` | String | yes |  | one of: template, legacy_cacao_2023, legacy_workbook |
| `originalName` | String | yes |  | at most 255 characters |
| `roundName` | String |  |  |  |
| `status` | String |  |  | one of: uploaded, validating, ready, committing, committed, failed |
| `summary` | Mixed |  |  |  |
| `surveyRoundId` | String |  |  |  |
| `uploadedById` | String | yes |  |  |

Indexes: `uploadedById, createdAt`; `status, updatedAt`

## `import_row_links`

| Field | Type | Required | PII | Notes |
|---|---|---|---|---|
| `cropStandId` | String |  |  |  |
| `farmerId` | String |  |  |  |
| `farmId` | String |  |  |  |
| `fileSha256` | String | yes |  |  |
| `jobId` | String | yes |  |  |
| `recordId` | String |  |  |  |
| `row` | Number | yes |  |  |
| `sheet` | String | yes |  |  |

Indexes: `fileSha256, sheet, row` (unique)

## `inventory_records`

| Field | Type | Required | PII | Notes |
|---|---|---|---|---|
| `approvedAt` | Date |  |  |  |
| `approvedById` | String |  |  |  |
| `barangayId` | String | yes |  |  |
| `cropStandId` | String | yes |  |  |
| `encodedById` | String |  |  |  |
| `flags` | Mixed |  |  |  |
| `municipalityId` | String | yes |  |  |
| `programId` | String | yes |  |  |
| `remarks` | String |  |  |  |
| `stageCounts` | Array of Mixed |  |  |  |
| `status` | String |  |  | one of: draft, submitted, validated, approved, locked |
| `submittedAt` | Date |  |  |  |
| `surveyRoundId` | String | yes |  |  |
| `validatedAt` | Date |  |  |  |
| `validatedById` | String |  |  |  |
| `version` | Number |  |  |  |

Indexes: `surveyRoundId, cropStandId` (unique); `surveyRoundId, municipalityId, status`

## `login_attempts`

| Field | Type | Required | PII | Notes |
|---|---|---|---|---|
| `expiresAt` | Date | yes |  |  |
| `failures` | Number | yes |  |  |

## `material_sources`

| Field | Type | Required | PII | Notes |
|---|---|---|---|---|
| `aliases` | Array of Mixed |  |  |  |
| `code` | String | yes |  | at most 30 characters; unique |
| `name` | String | yes |  | at most 100 characters |

## `municipalities`

| Field | Type | Required | PII | Notes |
|---|---|---|---|---|
| `boundary` | Mixed |  |  | left out of queries unless asked for |
| `name` | String | yes |  |  |
| `normalizedName` | String | yes |  | unique |
| `psgcCode` | String |  |  | unique |

## `plantings`

| Field | Type | Required | PII | Notes |
|---|---|---|---|---|
| `barangayId` | String | yes |  |  |
| `cropStandId` | String | yes |  |  |
| `municipalityId` | String | yes |  |  |
| `notes` | String |  |  |  |
| `programId` | String | yes |  |  |
| `qtyPlanted` | Number |  |  |  |
| `sourceId` | String |  |  |  |
| `varietyIds` | Array of Mixed |  |  |  |
| `yearPlanted` | Number |  |  |  |

## `programs`

| Field | Type | Required | PII | Notes |
|---|---|---|---|---|
| `code` | String | yes |  | at most 20 characters; unique |
| `name` | String | yes |  | at most 200 characters |

## `refresh_tokens`

| Field | Type | Required | PII | Notes |
|---|---|---|---|---|
| `expiresAt` | Date | yes |  |  |
| `revokedAt` | Date |  |  |  |
| `userId` | String | yes |  |  |

## `report_settings`

| Field | Type | Required | PII | Notes |
|---|---|---|---|---|
| `letterhead` | String |  |  |  |
| `logo` | Buffer |  |  | left out of queries unless asked for |
| `programLine` | String |  |  | at most 200 characters |

## `report_signoffs`

| Field | Type | Required | PII | Notes |
|---|---|---|---|---|
| `contentSha256` | String | yes |  |  |
| `reportKind` | String | yes |  | one of: summary, municipal_list |
| `signedAt` | Date | yes |  |  |
| `signedById` | String | yes |  |  |
| `surveyRoundId` | String | yes |  |  |

Indexes: `surveyRoundId, reportKind, signedAt`

## `signatories`

| Field | Type | Required | PII | Notes |
|---|---|---|---|---|
| `caption` | String | yes |  | at most 60 characters |
| `name` | String | yes | **PII** | at most 120 characters |
| `order` | Number |  |  |  |
| `reportKind` | String | yes |  | one of: summary, municipal_list |
| `title` | String |  |  | at most 160 characters |

Indexes: `reportKind, order`

## `survey_rounds`

| Field | Type | Required | PII | Notes |
|---|---|---|---|---|
| `asOfDate` | Date | yes |  |  |
| `closedAt` | Date |  |  |  |
| `closedById` | String |  |  |  |
| `commodityId` | String | yes |  |  |
| `deadline` | Date |  |  |  |
| `isHistorical` | Boolean |  |  |  |
| `name` | String | yes |  | at most 150 characters |
| `programId` | String | yes |  |  |
| `status` | String |  |  | one of: open, closed |

Indexes: `commodityId, name` (unique)

## `units`

| Field | Type | Required | PII | Notes |
|---|---|---|---|---|
| `aliases` | Array of Mixed |  |  |  |
| `code` | String | yes |  | at most 20 characters; unique |
| `kind` | String | yes |  | one of: mass, area, count, container |
| `name` | String | yes |  | at most 50 characters |
| `toBase` | Decimal128 |  |  |  |

## `user_assignments`

| Field | Type | Required | PII | Notes |
|---|---|---|---|---|
| `barangayIds` | Array of Mixed |  |  |  |
| `municipalityId` | String |  |  |  |
| `programId` | String |  |  |  |
| `role` | String | yes |  | one of: system_admin, provincial_head, program_coordinator, provincial_encoder, mao_validator, field_encoder, viewer |
| `userId` | String | yes |  |  |

Indexes: `userId, role, municipalityId, programId` (unique)

## `users`

| Field | Type | Required | PII | Notes |
|---|---|---|---|---|
| `email` | String | yes | **PII** | unique |
| `firstName` | String |  | **PII** |  |
| `isActive` | Boolean |  |  |  |
| `isSuperuser` | Boolean |  |  |  |
| `lastLoginAt` | Date |  |  |  |
| `lastName` | String |  | **PII** |  |
| `passwordHash` | String | yes | **PII** |  |

## `varieties`

| Field | Type | Required | PII | Notes |
|---|---|---|---|---|
| `aliases` | Array of Mixed |  |  |  |
| `code` | String | yes |  | at most 30 characters |
| `commodityId` | String | yes |  |  |
| `name` | String | yes |  | at most 100 characters |

Indexes: `commodityId, code` (unique)

## `workflow_comments`

| Field | Type | Required | PII | Notes |
|---|---|---|---|---|
| `action` | String | yes |  | at most 20 characters |
| `authorId` | String |  |  |  |
| `body` | String | yes |  |  |
| `inventoryRecordId` | String | yes |  |  |
| `number` | Number | yes |  |  |

Indexes: `inventoryRecordId, number` (unique)
