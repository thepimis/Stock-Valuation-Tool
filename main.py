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
    symbol_query = "SELECT DISTINCT act_symbol FROM income_statement WHERE sales IS NOT NULL AND sales > 0 ORDER BY act_symbol"
    try:
        symbol_rows = fetch_sql(symbol_query)
        symbols = [r.get("act_symbol") for r in symbol_rows if r.get("act_symbol")]
        print(f"--> Found {len(symbols)} total symbols to process.")
    except Exception as e:
        print(f"--> Error fetching symbols: {e}")
        return []

    processed_data = []
    batch_size = 100
    
    for i in range(0, len(symbols), batch_size):
        batch = symbols[i:i+batch_size]
        print(f"--> Processing batch {i//batch_size + 1} of {(len(symbols) + batch_size - 1)//batch_size} (Tickers: {batch[0]} to {batch[-1]})...")
        
        ticker_list_str = ", ".join([f"'{s}'" for s in batch])
        
        # Updated query to explicitly block 'YEAR' and 'ANNUAL' rows
        chunk_query = f"""
        SELECT act_symbol, date, period, sales, average_shares 
        FROM income_statement 
        WHERE act_symbol IN ({ticker_list_str}) 
          AND sales IS NOT NULL 
          AND sales > 0 
          AND UPPER(period) NOT IN ('FY', 'ANNUAL', 'A', '12M', 'Y', 'YEAR')
          AND UPPER(period) NOT LIKE '%YEAR%'
          AND UPPER(period) NOT LIKE '%ANNUAL%'
        ORDER BY act_symbol, date DESC
        """
        
        try:
            rows = fetch_sql(chunk_query)
        except Exception as e:
            print(f"    Warning: Failed batch {batch[0]}-{batch[-1]}: {e}")
            continue
            
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
            if len(records) < 4:
                continue
                
            latest_4_quarters = records[:4]

            try:
                raw_sales_sum = sum(float(q.get("sales") or 0.0) for q in latest_4_quarters)
                rev_in_billions = raw_sales_sum / 1e9 if raw_sales_sum > 1e6 else raw_sales_sum

                most_recent_q = latest_4_quarters[0]
                shares_in_billions = float(most_recent_q.get("average_shares") or 0.0)
            except (ValueError, TypeError):
                continue

            if rev_in_billions < 0.05: 
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
    print(f"--> Successfully processed {len(data)} stock tickers with valid TTM calculations!")
    
    if len(data) == 0:
        print("--> CRITICAL: API returned 0 records, aborting write.")
        sys.exit(1)

    with open("data.json", "w") as f:
        json.dump(data, f, indent=2)
        
    print("--> data.json updated successfully!")
