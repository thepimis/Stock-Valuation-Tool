import subprocess
import json

def get_data():
    # Query income_statement and extract latest revenue & shares
    query = """
    SELECT 
        act_symbol AS act_symbol,
        act_symbol AS symbol,
        act_symbol AS Name,
        period_end_date AS date,
        total_revenue AS RevenueTTM,
        weighted_average_shares_diluted AS SharesOutstanding,
        0.0 AS price
    FROM income_statement
    ORDER BY act_symbol, date DESC
    """
    
    result = subprocess.run(
        ["dolt", "sql", "-q", query, "--result-format", "json"],
        capture_output=True, text=True, cwd="earnings"
    )
    
    if result.stderr:
        print("Dolt stderr:", result.stderr)

    stdout = result.stdout.strip()
    
    if not stdout:
        raise ValueError("Dolt returned empty stdout.")

    if "[" in stdout and "]" in stdout:
        start = stdout.find("[")
        end = stdout.rfind("]") + 1
        stdout = stdout[start:end]

    records = json.loads(stdout)
    
    # Deduplicate to keep only the most recent entry for each ticker
    latest_by_ticker = {}
    for r in records:
        sym = r.get("act_symbol")
        if sym and sym not in latest_by_ticker:
            # Format numbers cleanly
            rev = float(r.get("RevenueTTM") or 0)
            shares = float(r.get("SharesOutstanding") or 0)
            
            r["RevenueTTM"] = rev
            r["SharesOutstanding"] = shares
            r["price"] = 0.0
            
            latest_by_ticker[sym] = r

    return list(latest_by_ticker.values())

data = get_data()
with open("data.json", "w") as f:
    json.dump(data, f)
