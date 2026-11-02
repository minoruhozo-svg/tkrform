//! ログイン失敗時の待ち時間（§7.2）。
//!
//! 5 回続けて失敗したら 30 秒待たせ、以後は失敗のたびに待ち時間を 2 倍にする（上限 10 分）。
//! 時刻は呼び出し側から渡す（テストしやすくするため）。

#[derive(Debug, Default, Clone)]
pub struct Throttle {
    failures: u32,
    /// この時刻（秒）まではログインを試せない
    blocked_until: u64,
}

pub const FREE_ATTEMPTS: u32 = 5;
pub const BASE_WAIT_SECS: u64 = 30;
pub const MAX_WAIT_SECS: u64 = 600;

impl Throttle {
    pub fn new() -> Self {
        Self::default()
    }

    /// 試行してよいなら `Ok(())`、まだなら残り秒数を `Err` で返す。
    pub fn check(&self, now: u64) -> Result<(), u64> {
        if now < self.blocked_until {
            Err(self.blocked_until - now)
        } else {
            Ok(())
        }
    }

    pub fn failure(&mut self, now: u64) {
        self.failures += 1;
        if self.failures >= FREE_ATTEMPTS {
            let exp = (self.failures - FREE_ATTEMPTS).min(20);
            let wait = BASE_WAIT_SECS.saturating_mul(1u64 << exp).min(MAX_WAIT_SECS);
            self.blocked_until = now + wait;
        }
    }

    pub fn success(&mut self) {
        *self = Self::default();
    }

    pub fn failures(&self) -> u32 {
        self.failures
    }
}
