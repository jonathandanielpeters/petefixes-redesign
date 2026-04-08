# Email Worker Setup (Resend + Cloudflare Workers)

## One-time setup (you do this once)

### 1. Create accounts
- **Resend**: Sign up at https://resend.com (free: 3,000 emails/month)
- **Cloudflare**: Sign up at https://cloudflare.com (free: 100K requests/day)

### 2. Install Wrangler CLI
```bash
npm install -g wrangler
wrangler login
```

### 3. Deploy the worker
```bash
cd services/email-worker
wrangler deploy
```
This gives you a URL like: `https://fence-estimate-email.<your-subdomain>.workers.dev`

### 4. Set your Resend API key
```bash
wrangler secret put RESEND_API_KEY
# Paste your key from https://resend.com/api-keys
```

### 5. Verify your sending domain in Resend
- Go to https://resend.com/domains
- Add your domain (e.g., `petefixes.ca`)
- Add the 3 DNS records Resend gives you (SPF, DKIM, DMARC)
- Wait for verification (usually minutes)

### 6. Update wrangler.toml with your "from" details
```toml
[vars]
FROM_NAME = "Pete Fixes"
FROM_EMAIL = "estimates@petefixes.ca"
```
Then redeploy: `wrangler deploy`

### 7. Update your fence tool config
In `configs/pete-fixes-wpg.json`, set:
```json
"emailApiUrl": "https://fence-estimate-email.<your-subdomain>.workers.dev"
```

---

## Per-client setup (for each new business client)

### 1. Verify client's domain in Resend
- Add their domain (e.g., `clientfence.com`) at https://resend.com/domains
- Send them the 3 DNS records to add to their domain registrar

### 2. Create a client-specific wrangler.toml
Copy `wrangler.toml` and update:
```toml
name = "fence-estimate-email-clientname"
[vars]
FROM_NAME = "Client Fence Co"
FROM_EMAIL = "estimates@clientfence.com"
```

### 3. Deploy and set API key
```bash
wrangler deploy -c wrangler-clientname.toml
wrangler secret put RESEND_API_KEY -c wrangler-clientname.toml
```

### 4. Update client's config
Set `emailApiUrl` to their worker URL in their deployment config.

---

## How it works

```
Customer clicks "Send Estimate"
    |
    v
Static site POSTs to Cloudflare Worker
    |
    v
Worker calls Resend API (Content-Type: text/html)
    |
    v
HTML email delivered to customer + internal P&L to owner
    |
    v
Works in Gmail, Outlook, Yahoo, Apple Mail -- everywhere
```

If `emailApiUrl` is empty, the tool falls back to EmailJS (legacy).

## Costs
- Resend free tier: 3,000 emails/month (100/day)
- Cloudflare Workers free tier: 100,000 requests/day
- Total cost for small businesses: $0/month
