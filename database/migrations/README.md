# Legacy V2 migrations

이 디렉터리는 V2 backup 복구와 current-only V3 export 검증을 위해 보존한다. 활성 애플리케이션은
이 파일들을 실행하지 않으며 빈 데이터베이스에는 `database/v3/0001_v3_initial.sql`부터 현재 head인
`database/v3/0004_pitch_metadata.sql`까지 순서대로 적용한다.
V2 데이터베이스에 V3 DDL을 적용하는 경로는 지원하지 않는다.
