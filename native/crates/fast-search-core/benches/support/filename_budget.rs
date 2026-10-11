use std::time::Duration;

pub fn filename_budget(value: Option<&str>) -> Result<Duration, &'static str> {
    let milliseconds = match value {
        None => 25,
        Some(value) => value.parse::<u64>().map_err(
            |_| "FAST_SEARCH_FILENAME_P95_MS must be a positive integer in milliseconds",
        )?,
    };
    if milliseconds == 0 {
        return Err("FAST_SEARCH_FILENAME_P95_MS must be greater than zero");
    }
    Ok(Duration::from_millis(milliseconds))
}

pub fn within_budget(measured: Duration, budget: Duration) -> bool {
    measured <= budget
}

pub fn filename_p95(samples: &mut [Duration]) -> Option<Duration> {
    if samples.is_empty() {
        return None;
    }
    samples.sort_unstable();
    Some(samples[samples.len() - samples.len() / 20 - 1])
}
