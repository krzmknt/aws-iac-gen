# aws-iac-gen

AWS Infrastructure as Code Generator - A CLI tool for generating CloudFormation templates from existing AWS resources.

## Overview

`aws-iac-gen` (or `iac-gen` for short) helps you generate CloudFormation templates from your existing AWS resources. It uses AWS CloudFormation's resource scanning capabilities to discover resources in your account and convert them into reusable Infrastructure as Code templates.

## Features

- **Resource Scanning**: Scan your AWS account for existing resources
- **Resource Discovery**: List and select from previous resource scans
- **Template Generation**: Convert discovered resources into CloudFormation templates
- **Stack Filtering**: Automatically excludes resources managed by existing CloudFormation stacks
- **Real-time Progress**: Visual feedback with spinners during long operations
- **Resource Limits**: Built-in warnings and errors for AWS limits (500 resources per template)

## Installation

```bash
npm install -g aws-iac-gen
```

Or install from source:

```bash
git clone https://github.com/krzmknt/aws-iac-gen.git
cd aws-iac-gen
npm install
npm run build
npm link
```

## Prerequisites

- Node.js 18 or higher
- AWS CLI configured with appropriate credentials
- AWS permissions for CloudFormation resource scanning and template generation

## Usage

### Commands

#### `iac-gen resources`

Download AWS resources from a scan.

Options:

- `--new-scan` - Start a new resource scan
- `--from-scan` - Choose from existing scans
- `-o, --output <file>` - Output file name (default: `resources.json`)

Examples:

```bash
# Start a new scan and save resources
iac-gen resources --new-scan

# Choose from existing scans
iac-gen resources --from-scan

# Specify custom output file
iac-gen resources --new-scan -o my-resources.json
```

#### `iac-gen template`

Generate a CloudFormation template from resources.

Options:

- `-i, --input <file>` - Input resources file (default: `resources.json`)
- `-o, --output <file>` - Output template file (default: `template.json`)
- `--from-stack <stack>` - Use an existing stack as the template base

Examples:

```bash
# Generate template from resources.json
iac-gen template

# Use custom input/output files
iac-gen template -i my-resources.json -o my-template.yaml

# Generate template from existing stack
iac-gen template --from-stack my-existing-stack
```

## Workflow Example

1. **Scan for resources**:

   ```bash
   iac-gen resources --new-scan
   ```

2. **Review the resources** (optional):

   ```bash
   cat resources.json | jq '.[] | .ResourceType' | sort | uniq -c
   ```

3. **Generate CloudFormation template**:

   ```bash
   iac-gen template
   ```

4. **Deploy the template** (using AWS CLI):
   ```bash
   aws cloudformation create-stack \
     --stack-name my-new-stack \
     --template-body file://template.json
   ```

## Important Notes

### Resource Limits

- AWS CloudFormation supports a maximum of 500 resources per template
- The tool will warn when your scan contains more than 500 resources
- Template generation will fail if you try to process more than 500 resources

### Stack-Managed Resources

- Resources already managed by CloudFormation stacks are automatically filtered out
- The tool shows how many stack-managed resources were excluded

### Scan Status

- Only `COMPLETE` scans can be used for resource extraction
- The tool will error if you select a scan that is still `IN_PROGRESS` or `FAILED`

## Configuration

The tool uses your AWS CLI configuration. Set your region using:

```bash
export AWS_REGION=us-east-1
# or
export AWS_DEFAULT_REGION=us-east-1
```

## Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev -- [command] [options]

# Build
npm run build

# Lint
npm run lint

# Format code
npm run format
```

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Troubleshooting

### "No scans found" error

- Ensure you have run at least one scan using `iac-gen resources --new-scan`
- Check that you're in the correct AWS region

### "Selected scan is in IN_PROGRESS status" error

- Wait for the scan to complete (usually takes a few minutes)
- Resource scans must be in `COMPLETE` status to extract resources

### "Resources file contains X resources, which exceeds the AWS limit of 500" error

- Filter your resources before generating a template
- Consider splitting resources into multiple templates
- Remove unnecessary resource types from the JSON file

### AWS Permissions

Ensure your AWS credentials have the following permissions:

- `cloudformation:StartResourceScan`
- `cloudformation:DescribeResourceScan`
- `cloudformation:ListResourceScans`
- `cloudformation:ListResourceScanResources`
- `cloudformation:CreateGeneratedTemplate`
- `cloudformation:DescribeGeneratedTemplate`
- `cloudformation:GetGeneratedTemplate`
