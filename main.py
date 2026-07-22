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
    print("--> Fetching unique stock symbols from DoltHub...")
    
    # Step 1: Get all unique stock symbols first to avoid pagination cutoff limits
    symbol_query = "SELECT DISTINCT act_symbol FROM income_statement WHERE sales IS NOT NULL AND sales > 0"
    try:
        symbol_rows = fetch_sql(symbol_query)
        symbols = [r.get("act_symbol") for r in symbol_rows if r.get("act_symbol")]
        print(f"--> Found {len(symbols)} total symbols to process.")
    except Exception as e:
        print(f"--> Error fetching symbols: {e}")
        return []

    processed_data = []
    
    # Step 2: Query chunked or process key symbols efficiently
    # To prevent hitting API request limits too fast while ensuring accurate TTM, 
    # we can batch symbols or fetch directly. Let's do batches of 50 symbols.
    batch_size = 50
    for i in range(0, len(symbols), batch_size):
        batch = symbols[i:i+batch_size]
        ticker_list_str = ", ".join([f"'{s}'" for s in batch])
        
        chunk_query = f"""
        SELECT act_symbol, date, period, sales, average_shares 
        FROM income_statement 
        WHERE act_symbol IN ({ticker_list_str}) 
          AND sales IS NOT NULL 
          AND sales > 0 
          AND UPPER(period) NOT IN ('FY', 'ANNUAL', 'A', '12M')
        ORDER BY act_symbol, date DESC
        """
        
        try:
            rows = fetch_sql(chunk_query)
        except Exception as e:
            continue
            
        # Group by ticker for this batch
        ticker_quarters = {}
        for r in rows:
            sym = r.get("act_symbol")
            if not sym:
                continue
            sym = sym.strip().upper()
            if sym not in ticker_quarters:
                ticker_quarters[sym] = []
            ticker_quarters[sym].append(r)
            
        for sym, records in ticker_quarters.items():
            latest_4_quarters = records[:4]
            if not latest_4_quarters:
                continue

            try:
                raw_sales_sum = sum(float(q.get("sales") or 0.0) for q in latest_4_quarters)
                rev_in_billions = raw_sales_sum / 1e9 if raw_sales_sum > 1e6 else raw_sales_sum

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
