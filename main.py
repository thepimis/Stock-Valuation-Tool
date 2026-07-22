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

def get_all_symbols():
    print("--> Fetching all stock symbols using alphabetical pagination...")
    all_symbols = []
    limit = 1000
    offset = 0
    
    while True:
        symbol_query = f"""
        SELECT DISTINCT act_symbol 
        FROM income_statement 
        WHERE sales IS NOT NULL AND sales > 0 
        ORDER BY act_symbol 
        LIMIT {limit} OFFSET {offset}
        """
        try:
            rows = fetch_sql(symbol_query)
            if not rows:
                break
            
            batch_symbols = [r.get("act_symbol") for r in rows if r.get("act_symbol")]
            if not batch_symbols:
                break
                
            all_symbols.extend(batch_symbols)
            print(f"    Fetched symbol offset {offset}: got {len(batch_symbols)} symbols...")
            
            if len(rows) < limit:
                break
            offset += limit
        except Exception as e:
            print(f"    Error fetching symbols at offset {offset}: {e}")
            break
            
    unique_symbols = sorted(list(set(all_symbols)))
    print(f"--> Total unique symbols found across the alphabet: {len(unique_symbols)}")
    return unique_symbols

def get_data():
    symbols = get_all_symbols()
    if not symbols:
        return []

    processed_data = []
    batch_size = 40
    
    for i in range(0, len(symbols), batch_size):
        batch = symbols[i:i+batch_size]
        ticker_list_str = ", ".join([f"'{s}'" for s in batch])
        
        # Corrected join using `e.shares_outstanding` as shown in the table schema
        chunk_query = f"""
        SELECT 
            i.act_symbol, 
            i.date, 
            i.period, 
            i.sales, 
            e.shares_outstanding 
        FROM income_statement i
        LEFT JOIN balance_sheet_equity e 
            ON i.act_symbol = e.act_symbol AND i.date = e.date AND i.period = e.period
        WHERE i.act_symbol IN ({ticker_list_str}) 
          AND i.sales IS NOT NULL 
          AND i.sales > 0 
          AND UPPER(i.period) NOT IN ('FY', 'ANNUAL', 'A', '12M', 'Y', 'YEAR')
          AND UPPER(i.period) NOT LIKE '%YEAR%'
          AND UPPER(i.period) NOT LIKE '%ANNUAL%'
        ORDER BY i.act_symbol, i.date DESC
        """
        
        try:
            rows = fetch_sql(chunk_query)
        except Exception:
            continue
            
        ticker_records = {}
        for r in rows:
            sym = r.get("act_symbol")
            if not sym:
                continue
            sym = sym.strip().upper()
            if sym not in ticker_records:
                ticker_records[sym] = []
            ticker_records[sym].append(r)
            
        for sym, records in ticker_records.items():
            if len(records) < 4:
                continue
                
            latest_4_quarters = records[:4]

            try:
                # Sum the exact 4 most recent quarters for true TTM Revenue
                raw_sales_sum = sum(float(q.get("sales") or 0.0) for q in latest_4_quarters)
                rev_in_billions = raw_sales_sum / 1e9 if raw_sales_sum > 1e6 else raw_sales_sum

                # Get shares outstanding from the correct balance_sheet_equity column
                most_recent_q = latest_4_quarters[0]
                shares_raw = float(most_recent_q.get("shares_outstanding") or 0.0)
                shares_in_billions = shares_raw / 1e9 if shares_raw > 1e6 else shares_raw
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
    print(f"--> Successfully processed {len(data)} total stock tickers from A to Z!")
    
    if len(data) == 0:
        print("--> CRITICAL: API returned 0 records, aborting write.")
        sys.exit(1)

    with open("data.json", "w") as f:
        json.dump(data, f, indent=2)
        
    print("--> data.json updated successfully!")
