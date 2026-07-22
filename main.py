import subprocess
import json
import os

TICKERS = ["AAPL", "MSFT", "GOOGL", "TSLA", "META", "AMZN", "NVDA", "INTU"]

def run_dolt_query(query, cwd_dir):
    cmd = ["dolt", "sql", "-q", query, "--result-format", "json"]
    kwargs = {"capture_output": True, "text": True}
    if cwd_dir and os.path.exists(cwd_dir):
        kwargs["cwd"] = cwd_dir

    result = subprocess.run(cmd, **kwargs)
    if result.stderr:
        print(f"Dolt stderr (cwd={cwd_dir}):", result.stderr)
    return result.stdout.strip()

def get_data():
    ticker_list_str = ", ".join([f"'{t}'" for t in TICKERS])
    
    # Determine directory
    cwd_dir = "earnings" if os.path.exists("earnings") else None

    # Try Query 1: income_statement
    query1 = f"""
    SELECT 
        act_symbol AS act_symbol,
        period_end_date AS date,
        total_revenue AS RevenueTTM,
        weighted_average_shares_diluted AS SharesOutstanding
    FROM income_statement
    WHERE act_symbol IN ({ticker_list_str})
    ORDER BY act_symbol, date DESC
    """
    
    stdout = run_dolt_query(query1, cwd_dir)

    # Fallback Query 2: earnings table if query1 produces nothing
    if not stdout or "[" not in stdout or stdout == "[]":
        print("income_statement empty/missing. Trying 'earnings' table...")
        query2 = f"""
        SELECT 
            act_symbol AS act_symbol,
            revenue AS RevenueTTM,
            shares_outstanding AS SharesOutstanding
        FROM earnings
        WHERE act_symbol IN ({ticker_list_str})
        """
        stdout = run_dolt_query(query2, cwd_dir)

    if not stdout or "[" not in stdout:
        print("CRITICAL: Dolt returned no JSON output!")
        return []

    try:
        start = stdout.find("[")
        end = stdout.rfind("]") + 1
        records = json.loads(stdout[start:end])
    except Exception as e:
        print(f"JSON Parsing Error: {e}")
        return []

    latest_by_ticker = {}
    for r in records:
        sym = r.get("act_symbol") or r.get("symbol")
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
                "price": 0.0
            }

    return list(latest_by_ticker.values())

if __name__ == "__main__":
    data = get_data()
    print(f"Successfully generated data for {len(data)} items: {data}")
    with open("data.json", "w") as f:
        json.dump(data, f, indent=2)
