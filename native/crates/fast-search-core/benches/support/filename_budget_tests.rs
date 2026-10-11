#[path = "filename_budget.rs"]
mod filename_budget;

mod tests {
    use super::filename_budget::{filename_budget, within_budget};
    use std::time::Duration;

    #[test]
    fn defaults_to_the_25_ms_release_budget() {
        assert_eq!(filename_budget(None), Ok(Duration::from_millis(25)));
    }

    #[test]
    fn accepts_the_40_ms_ci_budget() {
        assert_eq!(filename_budget(Some("40")), Ok(Duration::from_millis(40)));
    }

    #[test]
    fn rejects_zero() {
        assert!(filename_budget(Some("0")).is_err());
    }

    #[test]
    fn rejects_malformed_values() {
        assert!(filename_budget(Some("forty")).is_err());
        assert!(filename_budget(Some("")).is_err());
        assert!(filename_budget(Some("-1")).is_err());
        assert!(filename_budget(Some("40.5")).is_err());
    }

    #[test]
    fn rejects_overflow() {
        assert!(filename_budget(Some("18446744073709551616")).is_err());
    }

    #[test]
    fn accepts_exactly_40_ms() {
        assert!(within_budget(
            Duration::from_millis(40),
            Duration::from_millis(40)
        ));
    }

    #[test]
    fn rejects_one_nanosecond_over_40_ms() {
        assert!(!within_budget(
            Duration::from_millis(40) + Duration::from_nanos(1),
            Duration::from_millis(40)
        ));
    }
}
