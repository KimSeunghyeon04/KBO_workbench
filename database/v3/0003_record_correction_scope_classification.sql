-- Record-correction capability classification contract V2.
-- Source revisions remain immutable; only mutable assessment state is reclassified.
ALTER TABLE workbench.contract_metadata
  DROP CONSTRAINT IF EXISTS contract_metadata_record_correction_contract_version_check;

UPDATE workbench.contract_metadata
SET record_correction_contract_version=2
WHERE singleton;

ALTER TABLE workbench.contract_metadata
  ALTER COLUMN record_correction_contract_version SET DEFAULT 2,
  ADD CONSTRAINT contract_metadata_record_correction_contract_version_check
    CHECK (record_correction_contract_version = 2);

ALTER TABLE record_correction.match_assessments
  DROP CONSTRAINT match_assessments_status_check;

ALTER TABLE record_correction.match_assessments
  ADD CONSTRAINT match_assessments_status_check CHECK (status IN
    ('action_required','already_applied','manual_review','out_of_scope','unmatched','resolved','dismissed'));

UPDATE record_correction.match_assessments
SET status='out_of_scope',
    reason_message='현재 원장 계약에서 적용하거나 검증할 수 있는 플레이·통계 변경이 없어 원문 증거로만 보존합니다.'
WHERE status='manual_review' AND reason_code='evidence_only_notice';
