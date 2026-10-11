#[path = "filename_budget.rs"]
mod filename_budget;

mod tests {
    use super::filename_budget::{filename_budget, filename_p95, within_budget};
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

    #[test]
    fn p95_requires_measurements() {
        assert_eq!(filename_p95(&mut []), None);
    }

    #[test]
    fn p95_counts_all_samples_and_tolerates_exactly_five_percent_slow_samples() {
        let mut samples = vec![Duration::from_millis(100); 10];
        samples.extend([Duration::from_millis(40); 190]);
        assert_eq!(filename_p95(&mut samples), Some(Duration::from_millis(40)));
        assert!(within_budget(
            filename_p95(&mut samples).unwrap(),
            Duration::from_millis(40)
        ));
    }

    #[test]
    fn p95_rejects_more_than_five_percent_over_budget_samples() {
        let slow = Duration::from_millis(40) + Duration::from_nanos(1);
        let mut samples = vec![Duration::from_millis(10); 189];
        samples.extend([slow; 11]);
        assert_eq!(filename_p95(&mut samples), Some(slow));
        assert!(!within_budget(
            filename_p95(&mut samples).unwrap(),
            Duration::from_millis(40)
        ));
    }

    #[test]
    fn p95_does_not_hide_a_persistent_slowdown() {
        let mut samples = vec![Duration::from_millis(41); 200];
        assert!(!within_budget(
            filename_p95(&mut samples).unwrap(),
            Duration::from_millis(40)
        ));
    }
}
