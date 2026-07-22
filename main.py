import subprocess
import json

def get_data(tickers):
    # Create a comma-separated string of tickers for the SQL query, e.g., 'AAPL', 'MSFT'
    ticker_list = ", ".join([f"'{t}'" for t in tickers])
    
    # Query using act_symbol and period_end_date for post-no-preference/earnings DB
    query = f"SELECT * FROM income_statement WHERE act_symbol IN ({ticker_list}) ORDER BY act_symbol, period_end_date DESC"
    
    # Run the query
    result = subprocess.run(
        ["dolt", "sql", "-q", query, "--result-format", "json"],
        capture_output=True, text=True, cwd="earnings"
    )
    
    # Print diagnostic info to GitHub log if stderr is not empty
    if result.stderr:
        print("Dolt stderr:", result.stderr)

    stdout = result.stdout.strip()
    
    # Check if Dolt returned valid stdout
    if not stdout:
        raise ValueError(f"Dolt returned empty stdout. Exit code: {result.returncode}. Stderr: {result.stderr}")

    # If Dolt output contains warning/status text before the JSON array, extract the JSON portion
    if "[" in stdout and "]" in stdout:
        start = stdout.find("[")
        end = stdout.rfind("]") + 1
        stdout = stdout[start:end]

    # Parse JSON
    return json.loads(stdout)

# Add as many tickers as you like here
my_stocks = ["AAPL", "MSFT", "GOOGL", "TSLA"]

# Get the data and save it
data = get_data(my_stocks)
with open("data.json", "w") as f:
    json.dump(data, f)
