#!/usr/bin/env node

/**
 * iac-gen – Infrastructure-as-Code generator CLI
 *
 * Features
 * ├─ iac-gen new-scan
 * │   • Starts a new CloudFormation resource scan
 * │   • Polls until the scan is COMPLETE
 * │   • Saves the scanned resources to JSON (default: resources.json)
 * ├─ iac-gen from-scan
 * │   • Lists previous scans, lets the user pick one
 * │   • Downloads the resources for the chosen scan
 * │   • Saves them to JSON (default: resources.json)
 * └─ iac-gen template [--from-stack <stack>]
 *     • Reads a resources file (default: resources.json)
 *     • Creates a generated template (optionally seeding with an existing stack)
 *     • Polls until COMPLETE, then fetches the template
 *     • Saves it to a file (default: template.json)
 *
 * Build/run:
 *   npm i commander inquirer ora @aws-sdk/client-cloudformation
 *   ts-node cli.ts <sub-command> [...]
 */

import { Command } from 'commander';
import inquirer from 'inquirer';
import ora from 'ora';
import {
  CloudFormationClient,
  StartResourceScanCommand,
  DescribeResourceScanCommand,
  CreateGeneratedTemplateCommand,
  DescribeGeneratedTemplateCommand,
  GetGeneratedTemplateCommand,
  GeneratedTemplateDeletionPolicy,
  GeneratedTemplateUpdateReplacePolicy,
  paginateListResourceScanResources,
  paginateListResourceScans,
  type ResourceDefinition,
  type ScannedResource,
} from '@aws-sdk/client-cloudformation';
import { promises as fs } from 'fs';
import path from 'path';

const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'ap-northeast-1';
const cfn = new CloudFormationClient({ region: REGION });
const program = new Command().name('aws-iac-gen').version('0.2.2');

//
// ─── UTILITIES ────────────────────────────────────────────────────────────────
//
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function confirmPath(defaultName: string): Promise<string | null> {
  const { filename } = await inquirer.prompt({
    type: 'input',
    name: 'filename',
    message: 'Enter the output filename:',
    default: defaultName,
  });
  const full = path.resolve(process.cwd(), filename);
  const { ok } = await inquirer.prompt({
    type: 'confirm',
    name: 'ok',
    message: `Save to ${full}. Continue?`,
    default: true,
  });
  return ok ? full : null;
}

async function pollResourceScan(scanId: string): Promise<void> {
  const spin = ora(`Waiting for resource scan ${scanId}...`).start();
  while (true) {
    const { Status } = await cfn.send(new DescribeResourceScanCommand({ ResourceScanId: scanId }));
    if (Status === 'COMPLETE') {
      spin.succeed('Resource scan COMPLETE.');
      return;
    }
    if (Status === 'FAILED' || Status === 'EXPIRED') {
      spin.fail(`Resource scan ended with status ${Status}`);
      process.exit(1);
    }
    await sleep(10_000);
  }
}

async function pollGeneratedTemplate(templateId: string): Promise<void> {
  const spin = ora(`Waiting for generated template ${templateId}...`).start();
  while (true) {
    const { Status } = await cfn.send(
      new DescribeGeneratedTemplateCommand({ GeneratedTemplateName: templateId }),
    );
    if (Status === 'COMPLETE') {
      spin.succeed('Template generation COMPLETE.');
      return;
    }
    if (Status === 'FAILED') {
      spin.fail('Template generation FAILED.');
      process.exit(1);
    }
    await sleep(10_000);
  }
}

/* -------------------------------------------------------------------------- */
/*                            resources command                           */
/* -------------------------------------------------------------------------- */

program
  .command('resources')
  .description('Download AWS resources from a scan')
  .option('-o, --output <file>', 'output file name', 'resources.json')
  .option('--new-scan', 'start a new resource scan')
  .option('--from-scan', 'choose from existing scans')
  .action(async ({ output, newScan, fromScan }) => {
    if (!newScan && !fromScan) {
      console.error('Error: You must specify either --new-scan or --from-scan');
      process.exit(1);
    }
    if (newScan && fromScan) {
      console.error('Error: You cannot specify both --new-scan and --from-scan');
      process.exit(1);
    }

    let scanId: string;

    if (newScan) {
      // Start new scan
      const { ResourceScanId } = await cfn.send(new StartResourceScanCommand({}));
      if (!ResourceScanId) throw new Error('StartResourceScan did not return an ID');
      scanId = ResourceScanId;
      await pollResourceScan(scanId);
    } else {
      // Choose from existing scans
      const scans: { id: string; status: string; startTime?: Date }[] = [];
      for await (const page of paginateListResourceScans({ client: cfn }, {})) {
        for (const s of page.ResourceScanSummaries ?? []) {
          scans.push({
            id: s.ResourceScanId!,
            status: s.Status!,
            startTime: s.StartTime,
          });
        }
      }
      if (!scans.length) {
        console.error('No scans found.');
        return;
      }

      // Format table with headers and equal width columns
      const idWidth = 10;
      const statusWidth = 12;
      const dateWidth = 24;

      const formatRow = (id: string, status: string, date: string) => {
        return `${id.padEnd(idWidth)} │ ${status.padEnd(statusWidth)} │ ${date.padEnd(dateWidth)}`;
      };

      const { selectedScanId } = await inquirer.prompt({
        type: 'list',
        name: 'selectedScanId',
        message: 'Which scan would you like to use?',
        choices: scans.map((s) => ({
          name: formatRow(s.id.slice(-8), s.status, s.startTime?.toISOString() ?? '—'),
          value: s.id,
        })),
      });
      scanId = selectedScanId;

      // Check if selected scan is COMPLETE
      const selectedScan = scans.find((s) => s.id === scanId);
      if (selectedScan && selectedScan.status !== 'COMPLETE') {
        console.error(
          `Error: Selected scan is in ${selectedScan.status} status. Only COMPLETE scans can be used.`,
        );
        process.exit(1);
      }
    }

    // Download resources from the scan
    const downloadSpinner = ora('Downloading resources...').start();
    const resources: ScannedResource[] = [];
    try {
      for await (const page of paginateListResourceScanResources(
        { client: cfn },
        { ResourceScanId: scanId },
      )) {
        resources.push(...(page.Resources ?? []));
        downloadSpinner.text = `Downloading resources... ${resources.length} found`;
      }
      downloadSpinner.succeed(`Downloaded ${resources.length} resources`);
    } catch (error) {
      downloadSpinner.fail('Failed to download resources');
      throw error;
    }

    // Filter out resources where ManagedByStack is true and remove the property
    const cleanedResources = resources
      .filter((r) => r.ManagedByStack !== true)
      .map(({ ManagedByStack, ...rest }) => rest);

    // Warn if resources exceed 500
    if (cleanedResources.length > 500) {
      console.warn(
        `\n⚠️  Warning: You have ${cleanedResources.length} resources, which exceeds the limit of 500 for template generation.`,
      );
      console.warn('   Consider filtering resources or splitting them into multiple templates.\n');
    }

    // Ask for file confirmation just before saving
    const outFile = await confirmPath(output);
    if (!outFile) return;

    await fs.writeFile(outFile, JSON.stringify(cleanedResources, null, 2));
    console.log(
      `✓ Saved ${cleanedResources.length} resources → ${outFile} (filtered ${resources.length - cleanedResources.length} stack-managed resources)`,
    );
  });

/* -------------------------------------------------------------------------- */
/*                              template command                          */
/* -------------------------------------------------------------------------- */

program
  .command('template')
  .description('Generate a CloudFormation template from a resources.json file (or --from-stack)')
  .option('-i, --input <file>', 'input resources file', 'resources.json')
  .option('-o, --output <file>', 'output template file', 'template.json')
  .option('--from-stack <stack>', 'use an existing stack as the template base')
  .action(async ({ input, output, fromStack }) => {
    // Read resources file unless fromStack was supplied
    let resources: ScannedResource[] | undefined;
    if (!fromStack) {
      const data = await fs.readFile(path.resolve(process.cwd(), input), 'utf-8');
      resources = JSON.parse(data);
      if (!Array.isArray(resources) || resources.length === 0) {
        console.error('Resource list is empty.');
        return;
      }

      // Check if resources exceed 500
      if (resources.length > 500) {
        console.error(
          `Error: The resources file contains ${resources.length} resources, which exceeds the AWS limit of 500.`,
        );
        console.error('Please reduce the number of resources before generating a template.');
        process.exit(1);
      }
    }

    const name = `iacgen-${Date.now()}`;
    let GeneratedTemplateId: string | undefined;

    try {
      const result = await cfn.send(
        new CreateGeneratedTemplateCommand({
          GeneratedTemplateName: name,
          ...(fromStack ? { StackName: fromStack } : {}),
          ...(resources
            ? {
                Resources: resources.map(
                  (r) =>
                    ({
                      ResourceIdentifier: r.ResourceIdentifier ?? {},
                      ResourceType: r.ResourceType ?? '',
                    }) satisfies ResourceDefinition,
                ),
              }
            : {}),
          TemplateConfiguration: {
            DeletionPolicy: GeneratedTemplateDeletionPolicy.DELETE,
            UpdateReplacePolicy: GeneratedTemplateUpdateReplacePolicy.DELETE,
          },
        }),
      );
      GeneratedTemplateId = result.GeneratedTemplateId;
      if (!GeneratedTemplateId) throw new Error('CreateGeneratedTemplate did not return an ID');

      await pollGeneratedTemplate(GeneratedTemplateId);
    } catch (error: any) {
      if (error.message?.includes('Resources') && error.message?.includes('500')) {
        console.error(
          'Error: Failed to create template - AWS CloudFormation supports a maximum of 500 resources per template.',
        );
        console.error('Please reduce the number of resources and try again.');
      } else {
        console.error('Error creating template:', error.message || error);
      }
      process.exit(1);
    }

    const { TemplateBody } = await cfn.send(
      new GetGeneratedTemplateCommand({ GeneratedTemplateName: GeneratedTemplateId }),
    );

    // Ask for file confirmation just before saving
    const outFile = await confirmPath(output);
    if (!outFile) return;

    await fs.writeFile(outFile, TemplateBody || '');
    console.log(`✓ Template saved → ${outFile}`);
  });

program.parseAsync().catch((e) => {
  console.error(e);
  process.exit(1);
});
