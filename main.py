import subprocess
import json
import os
import sys

TICKERS = ["AAPL", "MSFT", "GOOGL", "TSLA", "META", "AMZN", "NVDA", "INTU"]

def get_data():
    ticker_list_str = ", ".join([f"'{t}'" for t in TICKERS])
    
    query = f"SELECT * FROM income_statement WHERE act_symbol IN ({ticker_list_str})"
    cwd_dir = "earnings" if os.path.exists("earnings") else None

    result = subprocess.run(
        ["dolt", "sql", "-q", query, "--result-format", "json"],
        capture_output=True, text=True, cwd=cwd_dir
    )
    
    stdout = result.stdout.strip()
    if not stdout or "[" not in stdout:
        print("Dolt Error:", result.stderr)
        return []

    start = stdout.find("[")
    end = stdout.rfind("]") + 1
    records = json.loads(stdout[start:end])

    if records:
        print("=== DB KEYS FOUND IN FIRST RECORD ===")
        print(list(records[0].keys()))
        print("=====================================")

    latest_by_ticker = {}
    for r in records:
        sym = r.get("act_symbol") or r.get("symbol")
        if sym and sym not in latest_by_ticker:
            # Map values dynamically using key matching
            rev = 0.0
            shares = 0.0

            for key, val in r.items():
                k_lower = key.lower()
                # Find revenue column
                if "revenue" in k_lower or "sales" in k_lower:
                    if val is not None:
                        try: rev = float(val)
                        except (ValueError, TypeError): pass
                # Find shares column
                if "share" in k_lower or "diluted" in k_lower:
                    if val is not None:
                        try: shares = float(val)
                        except (ValueError, TypeError): pass

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
    print(f"Sample processed item: {data[0] if data else 'None'}")
    
    if len(data) == 0:
        sys.exit(1)

    with open("data.json", "w") as f:
        json.dump(data, f, indent=2)
