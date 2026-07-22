import subprocess
import json

def get_data():
    # Query ALL stocks from the income_statement table
    query = "SELECT * FROM income_statement"
    
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

    # Extract JSON portion if warnings or non-JSON headers exist
    if "[" in stdout and "]" in stdout:
        start = stdout.find("[")
        end = stdout.rfind("]") + 1
        stdout = stdout[start:end]

    # Parse JSON
    return json.loads(stdout)

# Get all stock data and save it
data = get_data()
with open("data.json", "w") as f:
    json.dump(data, f)
