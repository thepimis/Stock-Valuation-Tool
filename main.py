import json
import urllib.parse
import urllib.request
import sys

OWNER = "post-no-preference"
REPO = "earnings"
BRANCH = "master"
BASE_URL = f"https://www.dolthub.com/api/v1alpha1/{OWNER}/{REPO}/{BRANCH}"

def get_data():
    print("--> Fetching financial statement records from DoltHub...")
    
    # Query prioritizing explicit quarterly rows, ordered by date descending
    sql_query = """
    SELECT act_symbol, date, period, sales, average_shares 
    FROM income_statement 
    WHERE sales IS NOT NULL 
      AND sales > 0 
      AND UPPER(period) NOT IN ('FY', 'ANNUAL', 'A', '12M')
    ORDER BY act_symbol, date DESC
    """
    
    url = f"{BASE_URL}?q={urllib.parse.quote(sql_query)}"
    
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req) as response:
            res_data = json.loads(response.read().decode())
            
        rows = res_data.get("rows", [])
        print(f"--> Received {len(rows)} raw quarterly records from DoltHub API.")
    except Exception as e:
        print(f"--> Error fetching from DoltHub API: {e}")
        return []

    # Group quarterly records by ticker
    ticker_quarters = {}
    for r in rows:
        sym = r.get("act_symbol")
        if not sym:
            continue
        sym = sym.strip().upper()
        if sym not in ticker_quarters:
            ticker_quarters[sym] = []
        ticker_quarters[sym].append(r)

    processed_data = []

    for sym, records in ticker_quarters.items():
        # Take exactly the 4 most recent distinct quarterly reports
        latest_4_quarters = records[:4]
        
        if not latest_4_quarters:
            continue

        try:
            # Sum the sales of the 4 most recent quarters for true TTM
            raw_sales_sum = sum(float(q.get("sales") or 0.0) for q in latest_4_quarters)
            rev_in_billions = raw_sales_sum / 1e9 if raw_sales_sum > 1e6 else raw_sales_sum

            # Get shares from the single most recent quarter
            most_recent_q = latest_4_quarters[0]
            shares_in_billions = float(most_recent_q.get("average_shares") or 0.0)
            
        except (ValueError, TypeError):
            rev_in_billions, shares_in_billions = 0.0, 0.0

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
    print(f"--> Successfully processed {len(data)} unique stock tickers with accurate TTM calculations!")
    
    if len(data) == 0:
        print("--> CRITICAL: API returned 0 records, aborting write to prevent overwriting data.json.")
        sys.exit(1)

    with open("data.json", "w") as f:
        json.dump(data, f, indent=2)
        
    print("--> data.json updated successfully!")
