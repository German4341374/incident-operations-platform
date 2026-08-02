# Load Smoke Results

The measured GitHub Actions baseline will be inserted here after the first successful CI run. No unexecuted command is represented as a result.

The committed test configuration is four sequential scenarios, three seconds each, ten concurrent clients for reads, and five for incident creation. Passing requires zero transport errors, zero non-2xx responses, and p99 below 2,000 ms for every scenario.
