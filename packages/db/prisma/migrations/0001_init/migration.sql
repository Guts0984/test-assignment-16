-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "order_status" AS ENUM ('received', 'awaiting_stock', 'reserved', 'in_wave', 'picking', 'picked', 'packed', 'shipped', 'cancelled');

-- CreateEnum
CREATE TYPE "delivery_method" AS ENUM ('standard', 'express');

-- CreateEnum
CREATE TYPE "staff_role" AS ENUM ('admin', 'shift_lead', 'storekeeper', 'picker', 'packer');

-- CreateEnum
CREATE TYPE "location_kind" AS ENUM ('storage', 'receiving', 'packing', 'return', 'transit');

-- CreateEnum
CREATE TYPE "movement_kind" AS ENUM ('receipt', 'putaway', 'reserve', 'unreserve', 'pick', 'ship', 'move', 'transfer_out', 'transfer_in', 'return', 'adjustment');

-- CreateTable
CREATE TABLE "warehouses" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "country" CHAR(2) NOT NULL,
    "time_zone" TEXT NOT NULL,
    "cutoff_local" TEXT NOT NULL,
    "working_days" INTEGER[],
    "holidays" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lat" DOUBLE PRECISION,
    "lon" DOUBLE PRECISION,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warehouses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zones" (
    "id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "zones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "locations" (
    "id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "zone_id" UUID,
    "kind" "location_kind" NOT NULL,
    "code" TEXT NOT NULL,
    "walk_order" INTEGER NOT NULL DEFAULT 0,
    "capacity_volume_cm3" BIGINT NOT NULL DEFAULT 0,
    "capacity_weight_g" BIGINT NOT NULL DEFAULT 0,
    "blocked_reason" TEXT,
    "transfer_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shops" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "webhook_url" TEXT NOT NULL,
    "webhook_secret_enc" TEXT NOT NULL,
    "min_shelf_life_days" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shop_api_keys" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "prefix" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(3),
    "last_used_at" TIMESTAMPTZ(3),

    CONSTRAINT "shop_api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shop_users" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shop_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_roles" (
    "id" UUID NOT NULL,
    "staff_id" UUID NOT NULL,
    "role" "staff_role" NOT NULL,
    "warehouse_id" UUID,

    CONSTRAINT "staff_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skus" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "barcode" TEXT NOT NULL,
    "weight_g" INTEGER NOT NULL,
    "length_mm" INTEGER NOT NULL,
    "width_mm" INTEGER NOT NULL,
    "height_mm" INTEGER NOT NULL,
    "tracks_expiry" BOOLEAN NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "skus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "batches" (
    "id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "expires_on" DATE,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_balances" (
    "location_id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "on_hand" INTEGER NOT NULL,
    "reserved" INTEGER NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_balances_pkey" PRIMARY KEY ("location_id","sku_id","batch_id")
);

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" BIGSERIAL NOT NULL,
    "group_id" UUID NOT NULL,
    "kind" "movement_kind" NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "on_hand_delta" INTEGER NOT NULL,
    "reserved_delta" INTEGER NOT NULL,
    "qty" INTEGER NOT NULL,
    "from_location_id" UUID,
    "to_location_id" UUID,
    "doc_type" TEXT NOT NULL,
    "doc_id" TEXT NOT NULL,
    "actor_type" TEXT NOT NULL,
    "actor_id" UUID,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbound_requests" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inbound_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbound_lines" (
    "id" UUID NOT NULL,
    "inbound_id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "expected_qty" INTEGER NOT NULL,

    CONSTRAINT "inbound_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipts" (
    "id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "inbound_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'open',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ(3),

    CONSTRAINT "receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipt_lines" (
    "id" UUID NOT NULL,
    "receipt_id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "qty" INTEGER NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receipt_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipt_discrepancies" (
    "id" UUID NOT NULL,
    "receipt_id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "expected_qty" INTEGER NOT NULL,
    "received_qty" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receipt_discrepancies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transfers" (
    "id" UUID NOT NULL,
    "from_warehouse_id" UUID NOT NULL,
    "to_warehouse_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'in_transit',
    "transit_location_id" UUID,
    "created_by" UUID NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "received_at" TIMESTAMPTZ(3),

    CONSTRAINT "transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transfer_lines" (
    "id" UUID NOT NULL,
    "transfer_id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "qty" INTEGER NOT NULL,
    "received_qty" INTEGER,

    CONSTRAINT "transfer_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "external_number" TEXT NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "status" "order_status" NOT NULL DEFAULT 'received',
    "delivery_method" "delivery_method" NOT NULL,
    "address" JSONB NOT NULL,
    "customer_name" TEXT NOT NULL,
    "country" CHAR(2) NOT NULL,
    "lat" DOUBLE PRECISION,
    "lon" DOUBLE PRECISION,
    "warehouse_id" UUID,
    "received_at" TIMESTAMPTZ(3) NOT NULL,
    "target_cutoff_at" TIMESTAMPTZ(3),
    "ship_day" DATE,
    "packed_at" TIMESTAMPTZ(3),
    "shipped_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "partial_reserve_expires_at" TIMESTAMPTZ(3),
    "all_or_nothing" BOOLEAN NOT NULL DEFAULT false,
    "status_version" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_lines" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "sku_id" UUID NOT NULL,
    "qty" INTEGER NOT NULL,
    "reserved_qty" INTEGER NOT NULL DEFAULT 0,
    "picked_qty" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_reservations" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "order_line_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "qty" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_status_history" (
    "id" BIGSERIAL NOT NULL,
    "order_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "from_status" "order_status",
    "to_status" "order_status" NOT NULL,
    "actor_type" TEXT NOT NULL,
    "actor_id" UUID,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "waves" (
    "id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "trigger" TEXT NOT NULL,
    "created_by" UUID,
    "order_count" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "waves_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wave_orders" (
    "id" UUID NOT NULL,
    "wave_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "wave_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pick_tasks" (
    "id" UUID NOT NULL,
    "wave_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "assignee_id" UUID,
    "priority_rank" INTEGER NOT NULL,
    "assigned_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pick_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pick_lines" (
    "id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "order_line_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "qty" INTEGER NOT NULL,
    "picked_qty" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'open',
    "walk_order" INTEGER NOT NULL,

    CONSTRAINT "pick_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pick_scans" (
    "id" UUID NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "line_id" UUID NOT NULL,
    "picker_id" UUID NOT NULL,
    "qty" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pick_scans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shortages" (
    "id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "line_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "picker_id" UUID NOT NULL,
    "expected_qty" INTEGER NOT NULL,
    "found_qty" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "shortages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_counts" (
    "id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "origin" TEXT NOT NULL,
    "assignee_id" UUID,
    "created_by" UUID,
    "needs_approval" BOOLEAN NOT NULL DEFAULT false,
    "approved_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "submitted_at" TIMESTAMPTZ(3),
    "closed_at" TIMESTAMPTZ(3),

    CONSTRAINT "stock_counts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_count_lines" (
    "id" UUID NOT NULL,
    "count_id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "system_qty" INTEGER NOT NULL,
    "counted_qty" INTEGER NOT NULL,
    "delta" INTEGER NOT NULL,
    "requires_approval" BOOLEAN NOT NULL,
    "reason" TEXT,
    "counted_by" UUID NOT NULL,

    CONSTRAINT "stock_count_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "adjustments" (
    "id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "count_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "delta" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "author_id" UUID NOT NULL,
    "approved_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "response" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("scope","key")
);

-- CreateTable
CREATE TABLE "scheduled_actions" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "due_at" TIMESTAMPTZ(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lease_until" TIMESTAMPTZ(3),
    "locked_by" TEXT,
    "last_error" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "run_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "scheduled_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_streams" (
    "shop_id" UUID NOT NULL,
    "stream" TEXT NOT NULL,
    "last_version" INTEGER NOT NULL DEFAULT 0,
    "last_sent_at" TIMESTAMPTZ(3),
    "dirty" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "webhook_streams_pkey" PRIMARY KEY ("shop_id","stream")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "stream" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "delivered_at" TIMESTAMPTZ(3),

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_batches" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "payload" JSONB NOT NULL,
    "results" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "import_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_clock" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "offset_ms" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "test_clock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seed_runs" (
    "profile" TEXT NOT NULL,
    "completed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "seed_runs_pkey" PRIMARY KEY ("profile")
);

-- CreateIndex
CREATE UNIQUE INDEX "warehouses_code_key" ON "warehouses"("code");

-- CreateIndex
CREATE UNIQUE INDEX "zones_warehouse_id_code_key" ON "zones"("warehouse_id", "code");

-- CreateIndex
CREATE INDEX "locations_warehouse_id_kind_walk_order_idx" ON "locations"("warehouse_id", "kind", "walk_order");

-- CreateIndex
CREATE UNIQUE INDEX "locations_warehouse_id_code_key" ON "locations"("warehouse_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "shops_code_key" ON "shops"("code");

-- CreateIndex
CREATE UNIQUE INDEX "shop_api_keys_prefix_key" ON "shop_api_keys"("prefix");

-- CreateIndex
CREATE INDEX "shop_api_keys_shop_id_idx" ON "shop_api_keys"("shop_id");

-- CreateIndex
CREATE UNIQUE INDEX "shop_users_email_key" ON "shop_users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "staff_email_key" ON "staff"("email");

-- CreateIndex
CREATE INDEX "staff_roles_staff_id_idx" ON "staff_roles"("staff_id");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_family_id_idx" ON "refresh_tokens"("family_id");

-- CreateIndex
CREATE INDEX "skus_barcode_idx" ON "skus"("barcode");

-- CreateIndex
CREATE UNIQUE INDEX "skus_shop_id_barcode_key" ON "skus"("shop_id", "barcode");

-- CreateIndex
CREATE UNIQUE INDEX "skus_shop_id_code_key" ON "skus"("shop_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "batches_sku_id_code_key" ON "batches"("sku_id", "code");

-- CreateIndex
CREATE INDEX "stock_balances_sku_id_warehouse_id_idx" ON "stock_balances"("sku_id", "warehouse_id");

-- CreateIndex
CREATE INDEX "stock_balances_warehouse_id_sku_id_idx" ON "stock_balances"("warehouse_id", "sku_id");

-- CreateIndex
CREATE INDEX "stock_movements_location_id_sku_id_batch_id_idx" ON "stock_movements"("location_id", "sku_id", "batch_id");

-- CreateIndex
CREATE INDEX "stock_movements_doc_type_doc_id_idx" ON "stock_movements"("doc_type", "doc_id");

-- CreateIndex
CREATE INDEX "stock_movements_warehouse_id_kind_created_at_idx" ON "stock_movements"("warehouse_id", "kind", "created_at");

-- CreateIndex
CREATE INDEX "stock_movements_actor_id_kind_created_at_idx" ON "stock_movements"("actor_id", "kind", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "inbound_requests_shop_id_reference_key" ON "inbound_requests"("shop_id", "reference");

-- CreateIndex
CREATE UNIQUE INDEX "inbound_lines_inbound_id_sku_id_key" ON "inbound_lines"("inbound_id", "sku_id");

-- CreateIndex
CREATE INDEX "receipts_warehouse_id_status_idx" ON "receipts"("warehouse_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "receipt_lines_idempotency_key_key" ON "receipt_lines"("idempotency_key");

-- CreateIndex
CREATE INDEX "receipt_lines_receipt_id_idx" ON "receipt_lines"("receipt_id");

-- CreateIndex
CREATE UNIQUE INDEX "receipt_discrepancies_receipt_id_sku_id_key" ON "receipt_discrepancies"("receipt_id", "sku_id");

-- CreateIndex
CREATE UNIQUE INDEX "transfers_idempotency_key_key" ON "transfers"("idempotency_key");

-- CreateIndex
CREATE INDEX "transfer_lines_transfer_id_idx" ON "transfer_lines"("transfer_id");

-- CreateIndex
CREATE INDEX "orders_warehouse_id_status_idx" ON "orders"("warehouse_id", "status");

-- CreateIndex
CREATE INDEX "orders_status_received_at_idx" ON "orders"("status", "received_at");

-- CreateIndex
CREATE INDEX "orders_shop_id_received_at_idx" ON "orders"("shop_id", "received_at");

-- CreateIndex
CREATE INDEX "orders_warehouse_id_shipped_at_idx" ON "orders"("warehouse_id", "shipped_at");

-- CreateIndex
CREATE UNIQUE INDEX "orders_shop_id_external_number_key" ON "orders"("shop_id", "external_number");

-- CreateIndex
CREATE INDEX "order_lines_sku_id_idx" ON "order_lines"("sku_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_lines_order_id_line_no_key" ON "order_lines"("order_id", "line_no");

-- CreateIndex
CREATE UNIQUE INDEX "order_lines_order_id_sku_id_key" ON "order_lines"("order_id", "sku_id");

-- CreateIndex
CREATE INDEX "order_reservations_order_id_idx" ON "order_reservations"("order_id");

-- CreateIndex
CREATE INDEX "order_reservations_location_id_sku_id_batch_id_idx" ON "order_reservations"("location_id", "sku_id", "batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_reservations_order_line_id_location_id_batch_id_key" ON "order_reservations"("order_line_id", "location_id", "batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_status_history_order_id_version_key" ON "order_status_history"("order_id", "version");

-- CreateIndex
CREATE INDEX "waves_warehouse_id_created_at_idx" ON "waves"("warehouse_id", "created_at");

-- CreateIndex
CREATE INDEX "wave_orders_wave_id_idx" ON "wave_orders"("wave_id");

-- CreateIndex
CREATE INDEX "pick_tasks_warehouse_id_status_priority_rank_idx" ON "pick_tasks"("warehouse_id", "status", "priority_rank");

-- CreateIndex
CREATE INDEX "pick_tasks_assignee_id_status_idx" ON "pick_tasks"("assignee_id", "status");

-- CreateIndex
CREATE INDEX "pick_lines_task_id_idx" ON "pick_lines"("task_id");

-- CreateIndex
CREATE INDEX "pick_lines_location_id_status_idx" ON "pick_lines"("location_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "pick_scans_idempotency_key_key" ON "pick_scans"("idempotency_key");

-- CreateIndex
CREATE INDEX "pick_scans_line_id_idx" ON "pick_scans"("line_id");

-- CreateIndex
CREATE INDEX "shortages_warehouse_id_created_at_idx" ON "shortages"("warehouse_id", "created_at");

-- CreateIndex
CREATE INDEX "stock_counts_warehouse_id_status_idx" ON "stock_counts"("warehouse_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "stock_count_lines_count_id_sku_id_batch_id_key" ON "stock_count_lines"("count_id", "sku_id", "batch_id");

-- CreateIndex
CREATE INDEX "adjustments_warehouse_id_created_at_idx" ON "adjustments"("warehouse_id", "created_at");

-- CreateIndex
CREATE INDEX "idempotency_records_created_at_idx" ON "idempotency_records"("created_at");

-- CreateIndex
CREATE INDEX "scheduled_actions_status_due_at_idx" ON "scheduled_actions"("status", "due_at");

-- CreateIndex
CREATE UNIQUE INDEX "scheduled_actions_kind_key_key" ON "scheduled_actions"("kind", "key");

-- CreateIndex
CREATE INDEX "webhook_events_status_next_attempt_at_idx" ON "webhook_events"("status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_shop_id_stream_version_key" ON "webhook_events"("shop_id", "stream", "version");

-- CreateIndex
CREATE INDEX "import_batches_shop_id_idx" ON "import_batches"("shop_id");

-- AddForeignKey
ALTER TABLE "zones" ADD CONSTRAINT "zones_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "locations" ADD CONSTRAINT "locations_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "locations" ADD CONSTRAINT "locations_zone_id_fkey" FOREIGN KEY ("zone_id") REFERENCES "zones"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_roles" ADD CONSTRAINT "staff_roles_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_lines" ADD CONSTRAINT "inbound_lines_inbound_id_fkey" FOREIGN KEY ("inbound_id") REFERENCES "inbound_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

