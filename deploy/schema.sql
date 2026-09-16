-- AC 麻将 · MySQL 权威存储 schema（6 表，见架构文档 §11.3）
-- docker compose 首次启动 MySQL 时自动执行；也可手动： mysql -uroot -proot < schema.sql

CREATE TABLE IF NOT EXISTS users (
  openid        VARCHAR(64)  NOT NULL,
  nickname      VARCHAR(64)  NOT NULL DEFAULT '',
  avatar_url    VARCHAR(512) NOT NULL DEFAULT '',
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_login_at DATETIME(3)  NULL,
  PRIMARY KEY (openid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS rooms (
  room_id        VARCHAR(16) NOT NULL,
  host_openid    VARCHAR(64) NOT NULL,
  max_rounds     INT         NOT NULL,
  initial_score  JSON        NOT NULL,   -- {[seat]:score} 开局分配
  final_score    JSON        NULL,       -- {[seat]:score} 房间关闭快照（D-32：不做账户余额）
  status         ENUM('idle','playing','closed') NOT NULL DEFAULT 'idle',
  created_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  closed_at      DATETIME(3) NULL,
  PRIMARY KEY (room_id),
  KEY idx_host (host_openid),
  KEY idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS room_member_events (
  id      BIGINT      NOT NULL AUTO_INCREMENT,
  room_id VARCHAR(16) NOT NULL,
  openid  VARCHAR(64) NOT NULL,
  seat    INT         NULL,
  event   ENUM('create','join','leave','ready') NOT NULL,
  at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_room_time (room_id, at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS games (
  game_id     VARCHAR(24) NOT NULL,      -- 形如 {roomId}:{roundNo}
  room_id     VARCHAR(16) NOT NULL,
  round_no    INT         NOT NULL,
  dealer_seat INT         NOT NULL,
  seed        BIGINT      NOT NULL,      -- 交叉校验用
  end_type    ENUM('win','exhaustive') NULL,
  result      JSON        NULL,          -- 局末结算明细
  started_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  ended_at    DATETIME(3) NULL,
  PRIMARY KEY (game_id),
  KEY idx_room_round (room_id, round_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS game_initial_states (
  game_id          VARCHAR(24) NOT NULL,
  wall             JSON        NOT NULL,  -- 发牌后剩余牌墙 TileId[]
  hands            JSON        NOT NULL,  -- [{seat,concealed,melds,flowers,zi,score}]
  lianzhuang_count INT         NOT NULL DEFAULT 0,
  PRIMARY KEY (game_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS game_actions (
  id          BIGINT      NOT NULL AUTO_INCREMENT,
  game_id     VARCHAR(24) NOT NULL,
  seq         INT         NOT NULL,
  seat        INT         NULL,
  action_type VARCHAR(24) NOT NULL,
  payload     JSON        NOT NULL,       -- 完整 Action，回放直接用
  at          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_game_seq (game_id, seq)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
