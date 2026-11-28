// #138: the server loggers read LOG_LEVEL at call time and default to info. On 2026-11-26 a
// green run printed 54 JSON log lines between the results. Tests that read log lines give
// their own logger. Set LOG_LEVEL in the shell to see the lines when you debug a test.
process.env.LOG_LEVEL ??= 'silent';
