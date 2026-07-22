import subprocess
import json

def get_data(tickers):
    # Create a comma-separated string of tickers for the SQL query, e.g., 'AAPL', 'MSFT'
    ticker_list = ", ".join([f"'{t}'" for t in tickers])
    
    # Use the 'IN' operator to fetch all stocks at once
    query = f"SELECT * FROM income_statement WHERE symbol IN ({ticker_list}) ORDER BY symbol, fiscal_date DESC"
    
    # Run the query
    result = subprocess.run(
        ["dolt", "sql", "-q", query, "--result-format", "json"],
        capture_output=True, text=True, cwd="earnings"
    )
    
    # Return the parsed data
    return json.loads(result.stdout)

# Add as many tickers as you like here
my_stocks = ["AAPL", "MSFT", "GOOGL", "TSLA"]

# Get the data and save it
data = get_data(my_stocks)
with open("data.json", "w") as f:
    json.dump(data, f)