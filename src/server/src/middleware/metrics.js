/**
 * Simple Prometheus-compatible metrics middleware
 * Collects request count, response time, and error rate
 */

const metrics = {
  requests: { total: 0, byMethod: {}, byStatus: {}, byPath: {} },
  responseTimes: [],
  errors: { total: 0, byType: {} },
  wsConnections: { total: 0, current: 0 },
  startTime: Date.now(),
};

export function metricsMiddleware(req, res, next) {
  const start = Date.now();

  // Track request
  metrics.requests.total++;
  metrics.requests.byMethod[req.method] = (metrics.requests.byMethod[req.method] || 0) + 1;

  // Track response
  res.on('finish', () => {
    const duration = Date.now() - start;
    metrics.responseTimes.push(duration);

    // Keep only last 1000 response times
    if (metrics.responseTimes.length > 1000) {
      metrics.responseTimes = metrics.responseTimes.slice(-1000);
    }

    // Track status code
    const statusGroup = `${Math.floor(res.statusCode / 100)}xx`;
    metrics.requests.byStatus[statusGroup] = (metrics.requests.byStatus[statusGroup] || 0) + 1;
    metrics.requests.byStatus[res.statusCode] = (metrics.requests.byStatus[res.statusCode] || 0) + 1;

    // Track errors
    if (res.statusCode >= 500) {
      metrics.errors.total++;
      metrics.errors.byType[res.statusCode] = (metrics.errors.byType[res.statusCode] || 0) + 1;
    }
  });

  next();
}

function getPercentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const index = Math.ceil(sorted.length * p / 100) - 1;
  return sorted[Math.max(0, index)];
}

function getAverage(arr) {
  if (arr.length === 0) return 0;
  return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
}

export function getMetrics() {
  const uptime = Math.round((Date.now() - metrics.startTime) / 1000);
  const responseTimes = metrics.responseTimes;

  return {
    uptime,
    requests: {
      total: metrics.requests.total,
      byMethod: metrics.requests.byMethod,
      byStatus: metrics.requests.byStatus,
    },
    responseTime: {
      avg: getAverage(responseTimes),
      p50: getPercentile(responseTimes, 50),
      p95: getPercentile(responseTimes, 95),
      p99: getPercentile(responseTimes, 99),
      max: Math.max(...responseTimes, 0),
    },
    errors: {
      total: metrics.errors.total,
      rate: metrics.requests.total > 0
        ? (metrics.errors.total / metrics.requests.total * 100).toFixed(2) + '%'
        : '0%',
    },
    wsConnections: metrics.wsConnections,
    memory: {
      rss: Math.round(process.memoryUsage().rss / 1024 / 1024) + 'MB',
      heap: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
      external: Math.round(process.memoryUsage().external / 1024 / 1024) + 'MB',
    },
  };
}

export function getPrometheusMetrics() {
  const m = getMetrics();
  const lines = [];

  lines.push(`# HELP clipsync_uptime_seconds Server uptime in seconds`);
  lines.push(`# TYPE clipsync_uptime_seconds gauge`);
  lines.push(`clipsync_uptime_seconds ${m.uptime}`);

  lines.push(`# HELP clipsync_requests_total Total HTTP requests`);
  lines.push(`# TYPE clipsync_requests_total counter`);
  lines.push(`clipsync_requests_total ${m.requests.total}`);

  for (const [method, count] of Object.entries(m.requests.byMethod)) {
    lines.push(`clipsync_requests_total{method="${method}"} ${count}`);
  }

  lines.push(`# HELP clipsync_response_time_seconds Response time`);
  lines.push(`# TYPE clipsync_response_time_seconds summary`);
  lines.push(`clipsync_response_time_seconds{quantile="0.5"} ${m.responseTime.p50 / 1000}`);
  lines.push(`clipsync_response_time_seconds{quantile="0.95"} ${m.responseTime.p95 / 1000}`);
  lines.push(`clipsync_response_time_seconds{quantile="0.99"} ${m.responseTime.p99 / 1000}`);
  lines.push(`clipsync_response_time_seconds_sum ${getAverage(m.requests.total ? metrics.responseTimes : [0]) / 1000}`);
  lines.push(`clipsync_response_time_seconds_count ${m.requests.total}`);

  lines.push(`# HELP clipsync_errors_total Total server errors`);
  lines.push(`# TYPE clipsync_errors_total counter`);
  lines.push(`clipsync_errors_total ${m.errors.total}`);

  lines.push(`# HELP clipsync_memory_bytes Memory usage`);
  lines.push(`# TYPE clipsync_memory_bytes gauge`);
  lines.push(`clipsync_memory_bytes{type="rss"} ${parseInt(m.memory.rss) * 1024 * 1024}`);
  lines.push(`clipsync_memory_bytes{type="heap"} ${parseInt(m.memory.heap) * 1024 * 1024}`);

  return lines.join('\n');
}
