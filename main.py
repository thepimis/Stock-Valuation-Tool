import subprocess
import json
import os
import sys

TICKERS = ["AAPL", "MSFT", "GOOGL", "TSLA", "META", "AMZN", "NVDA", "INTU"]

def get_data():
    ticker_list_str = ", ".join([f"'{t}'" for t in TICKERS])
    
    # Simple query selecting all columns to avoid missing-column errors
    query = f"""
    SELECT * FROM income_statement 
    WHERE act_symbol IN ({ticker_list_str})
    """
    
    cwd_dir = "earnings" if os.path.exists("earnings") else None

    result = subprocess.run(
        ["dolt", "sql", "-q", query, "--result-format", "json"],
        capture_output=True, text=True, cwd=cwd_dir
    )
    
    stdout = result.stdout.strip()

    if not stdout or "[" not in stdout:
        print("Dolt Error output:", result.stderr)
        return []

    start = stdout.find("[")
    end = stdout.rfind("]") + 1
    records = json.loads(stdout[start:end])

    latest_by_ticker = {}
    for r in records:
        sym = r.get("act_symbol") or r.get("symbol")
        if sym and sym not in latest_by_ticker:
            # Map revenue and shares from whatever column names Dolt provides
            rev = r.get("total_revenue") or r.get("revenue") or r.get("RevenueTTM") or 0.0
            shares = r.get("weighted_average_shares_diluted") or r.get("shares_outstanding") or r.get("SharesOutstanding") or 0.0

            try:
                rev = float(rev)
                shares = float(shares)
            except (ValueError, TypeError):
                rev, shares = 0.0, 0.0

            latest_by_ticker[sym] = {
                "act_symbol": sym,
                "symbol": sym,
                "Name": sym,
                "RevenueTTM": rev,
                "SharesOutstanding": shares,
                "price": 0.0
            }

    return list(latest_by_ticker.values())

if __name__ == "__main__":
    data = get_data()
    print(f"Successfully generated data for {len(data)} items: {[d['symbol'] for d in data]}")
    
    if len(data) == 0:
        print("CRITICAL: No data fetched, aborting file write.")
        sys.exit(1)

    with open("data.json", "w") as f:
        json.dump(data, f, indent=2)
