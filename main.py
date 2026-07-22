import json
import urllib.parse
import urllib.request
import sys

OWNER = "post-no-preference"
REPO = "earnings"
BRANCH = "master"
BASE_URL = f"https://www.dolthub.com/api/v1alpha1/{OWNER}/{REPO}/{BRANCH}"

def fetch_sql(query):
    url = f"{BASE_URL}?q={urllib.parse.quote(query)}"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req) as response:
        res_data = json.loads(response.read().decode())
        return res_data.get("rows", [])

def get_data():
    print("--> Fetching filtered income statement data from DoltHub...")
    # Filter directly in SQL to ignore micro-caps and prevent timeouts
    income_query = """
    SELECT act_symbol, date, period, sales 
    FROM income_statement 
    WHERE sales IS NOT NULL 
      AND sales > 100000000 
      AND UPPER(period) NOT IN ('FY', 'ANNUAL', 'A', '12M', 'Y', 'YEAR')
      AND UPPER(period) NOT LIKE '%YEAR%'
      AND UPPER(period) NOT LIKE '%ANNUAL%'
    ORDER BY act_symbol, date DESC
    """
    income_rows = fetch_sql(income_query)
    print(f"--> Retrieved {len(income_rows)} relevant income statement rows.")

    print("--> Fetching balance sheet equity share data...")
    equity_query = """
    SELECT act_symbol, date, period, shares_outstanding 
    FROM balance_sheet_equity 
    WHERE shares_outstanding IS NOT NULL
    """
    equity_rows = fetch_sql(equity_query)
    print(f"--> Retrieved {len(equity_rows)} equity rows.")

    shares_lookup = {}
    for r in equity_rows:
        sym = r.get("act_symbol")
        dt = r.get("date")
        per = r.get("period")
        if sym and dt and per:
            key = (sym.strip().upper(), str(dt).strip(), str(per).strip().upper())
            shares_lookup[key] = r.get("shares_outstanding")

    ticker_records = {}
    for r in income_rows:
        sym = r.get("act_symbol")
        if not sym:
            continue
        sym = sym.strip().upper()
        if sym not in ticker_records:
            ticker_records[sym] = []
        ticker_records[sym].append(r)

    processed_data = []

    print("--> Processing and aggregating TTM metrics...")
    for sym, records in ticker_records.items():
        if len(records) < 4:
            continue
            
        latest_4_quarters = records[:4]

        try:
            raw_sales_sum = sum(float(q.get("sales") or 0.0) for q in latest_4_quarters)
            rev_in_billions = raw_sales_sum / 1e9

            most_recent_q = latest_4_quarters[0]
            q_sym = sym
            q_date = str(most_recent_q.get("date", "")).strip()
            q_period = str(most_recent_q.get("period", "")).strip().upper()
            
            shares_raw = float(shares_lookup.get((q_sym, q_date, q_period), 0.0))
            shares_in_billions = shares_raw / 1e9 if shares_raw > 1e6 else shares_raw
        except (ValueError, TypeError):
            continue

        processed_data.append({
            "act_symbol": sym,
            "symbol": sym,
            "Name": sym,
            "RevenueTTM": round(rev_in_billions, 2),
            "SharesOutstanding": round(shares_in_billions, 3),
            "price": 0.0
        })

    return processed_data

if __name__ == "__main__":
    data = get_data()
    print(f"--> Successfully processed {len(data)} major stock tickers!")
    
    if len(data) == 0:
        print("--> CRITICAL: API returned 0 records, aborting write.")
        sys.exit(1)

    with open("data.json", "w") as f:
        json.dump(data, f, indent=2)
        
    print("--> data.json updated successfully!")
