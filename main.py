import subprocess
import json

# Add all tickers you want to support here
TICKERS = ["AAPL", "MSFT", "GOOGL", "TSLA", "META", "AMZN", "NVDA", "INTU"]

def get_data():
    ticker_list_str = ", ".join([f"'{t}'" for t in TICKERS])
    
    # Query income_statement for revenue, shares, and recent dates
    query = f"""
    SELECT 
        act_symbol AS act_symbol,
        act_symbol AS symbol,
        period_end_date AS date,
        total_revenue AS RevenueTTM,
        weighted_average_shares_diluted AS SharesOutstanding
    FROM income_statement
    WHERE act_symbol IN ({ticker_list_str})
    ORDER BY act_symbol, date DESC
    """
    
    result = subprocess.run(
        ["dolt", "sql", "-q", query, "--result-format", "json"],
        capture_output=True, text=True, cwd="earnings"
    )
    
    if result.stderr:
        print("Dolt stderr:", result.stderr)

    stdout = result.stdout.strip()
    if not stdout or "[" not in stdout:
        print("No valid JSON output from Dolt. Output was:", stdout)
        return []

    start = stdout.find("[")
    end = stdout.rfind("]") + 1
    records = json.loads(stdout[start:end])
    
    # Keep only the latest statement per ticker
    latest_by_ticker = {}
    for r in records:
        sym = r.get("act_symbol")
        if sym and sym not in latest_by_ticker:
            try:
                rev = float(r.get("RevenueTTM") or 0)
                shares = float(r.get("SharesOutstanding") or 0)
            except (ValueError, TypeError):
                rev, shares = 0.0, 0.0

            latest_by_ticker[sym] = {
                "act_symbol": sym,
                "symbol": sym,
                "Name": sym,
                "RevenueTTM": rev,
                "SharesOutstanding": shares,
                "price": 0.0  # Stock price can be entered in UI or fetched via API
            }

    return list(latest_by_ticker.values())

if __name__ == "__main__":
    data = get_data()
    print(f"Generated data for {len(data)} stocks: {[d['act_symbol'] for d in data]}")
    with open("data.json", "w") as f:
        json.dump(data, f, indent=2)
