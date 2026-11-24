-- Rättning: UNIQUE med NULL-kolumn (product) deduplicerar inte i PostgreSQL, så gallringsjobbet skapade dubbletter.
alter table purge_candidates drop constraint purge_candidates_workspace_id_product_reason_key;
create unique index purge_candidates_uq on purge_candidates (workspace_id, product, reason) nulls not distinct;
