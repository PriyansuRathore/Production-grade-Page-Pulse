# Page Pulse

Production-grade URL audit service.

This service allows you to perform a quick audit of a URL to get its status code, content type, and size. It's built with resiliency in mind, featuring rate limiting, caching, and structured logging.

## Features

- **URL Auditing**: Get key metrics for any public URL.
- **Caching**: Results are cached for a configurable window to provide faster subsequent responses.
- **Rate Limiting**: To prevent abuse, the API is rate-limited.
- **Concurrency Control**: Limits the number of simultaneous audits.
- **Structured Logging**: JSON logs for better observability.
- **Health Check**: An endpoint to monitor the service's status.

## API

### Audit a URL

- **Endpoint**: `POST /api/audit`
- **Description**: Submits a URL for auditing.

#### Request Body

```json
{
  "url": "https://example.com"
}
```

- `url` (string, required): The full URL to audit (must start with `http://` or `https://`).

#### Success Response (200 OK)

```json
{
  "success": true,
  "result": {
    "url": "https://example.com",
    "statusCode": 200,
    "contentType": "text/html; charset=utf-8",
    "bytes": 1256,
    "cached": false,
    "requestId": "a1b2c3d4-e5f6-7890-1234-567890abcdef"
  }
}
```

#### Error Responses

- **400 Bad Request** (`VALIDATION_ERROR`): The provided URL is invalid.
- **429 Too Many Requests** (`RATE_LIMITED`): The client has exceeded the rate limit.
- **429 Too Many Requests** (`CONCURRENCY_LIMITED`): Too many audits are running at the moment.
- **504 Gateway Timeout** (`REQUEST_TIMEOUT`): The request to the upstream URL timed out.
- **502 Bad Gateway** (`UPSTREAM_ERROR`): The upstream service could not be reached.

### Health Check

- **Endpoint**: `GET /health`
- **Description**: Checks the health of the service.

#### Success Response (200 OK)

```json
{
  "success": true,
  "service": "page-pulse",
  "credit": "Built for Digital Heroes Training Task (digitalheroesco.com)",
  "requestId": "b2c3d4e5-f6g7-8901-2345-67890abcdefg"
}
```

## Setup and Running

### Prerequisites

- Node.js (v18 or higher)
- npm

### Installation

1.  Clone the repository.
2.  Install dependencies:
    ```bash
    npm install
    ```

### Running the Service

```bash
npm start
```

The service will be available at `http://localhost:3000`.

### Running Tests

```bash
npm test
```

---

*Built for Digital Heroes Training Task, linked to [digitalheroesco.com](https://digitalheroesco.com)*
