const { graphql } = require('@octokit/graphql');

// Configuration - UPDATE THESE VALUES
const CONFIG = {
  projectId: process.env.PROJECT_ID,
  effortFieldName: 'Effort',         // Name of your effort custom field
  progressFieldName: 'Completion %'  // Name of your progress custom field
};

const graphqlWithAuth = graphql.defaults({
  headers: {
    authorization: `token ${process.env.GITHUB_TOKEN}`,
    'GraphQL-Features': 'sub_issues'
  },
});

async function getProjectFields(projectId) {
  console.log('📋 Fetching project fields...');
  const query = `
    query($projectId: ID!) {
      node(id: $projectId) {
        ... on ProjectV2 {
          id
          title
          fields(first: 50) {
            nodes {
              ... on ProjectV2Field {
                id
                name
                dataType
              }
              ... on ProjectV2SingleSelectField {
                id
                name
                dataType
              }
            }
          }
        }
      }
    }
  `;

  const result = await graphqlWithAuth(query, { projectId });
  console.log(`✅ Found project: ${result.node.title}`);
  return result.node.fields.nodes;
}

async function getAllProjectItems(projectId) {
  console.log('🔍 Fetching all project items...');
  const query = `
    query($projectId: ID!, $cursor: String) {
      node(id: $projectId) {
        ... on ProjectV2 {
          items(first: 100, after: $cursor) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              id
              content {
                ... on Issue {
                  id
                  number
                  title
                  state
                  stateReason
                  repository {
                    owner {
                      login
                    }
                    name
                  }
                  subIssues(first: 100) {
                    nodes {
                      id
                      number
                      state
                      stateReason
                    }
                  }
                }
              }
              fieldValues(first: 50) {
                nodes {
                  ... on ProjectV2ItemFieldNumberValue {
                    field {
                      ... on ProjectV2Field {
                        id
                        name
                      }
                    }
                    number
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  let allItems = [];
  let hasNextPage = true;
  let cursor = null;

  while (hasNextPage) {
    const result = await graphqlWithAuth(query, { projectId, cursor });
    const items = result.node.items;
    
    allItems = allItems.concat(items.nodes);
    hasNextPage = items.pageInfo.hasNextPage;
    cursor = items.pageInfo.endCursor;
  }

  console.log(`✅ Found ${allItems.length} items in project`);
  return allItems;
}

async function getIssueWithSubIssues(issueId) {
  console.log(`📝 Fetching issue details for ${issueId}...`);
  const query = `
    query($issueId: ID!) {
      node(id: $issueId) {
        ... on Issue {
          id
          number
          title
          repository {
            owner {
              login
            }
            name
          }
          subIssues(first: 100) {
            nodes {
              id
              number
              state
              stateReason
            }
          }
        }
      }
    }
  `;

  const result = await graphqlWithAuth(query, { issueId });
  return result.node;
}

function getEffortFromItem(item, effortFieldName) {
  const effortValue = item.fieldValues.nodes.find(
    fv => fv.field && fv.field.name === effortFieldName
  );
  return effortValue ? (effortValue.number || 0) : 0;
}

async function updateProgressField(projectId, projectItemId, progressFieldId, value) {
  const mutation = `
    mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: Float!) {
      updateProjectV2ItemFieldValue(
        input: {
          projectId: $projectId
          itemId: $itemId
          fieldId: $fieldId
          value: {
            number: $value
          }
        }
      ) {
        projectV2Item {
          id
        }
      }
    }
  `;

  await graphqlWithAuth(mutation, {
    projectId,
    itemId: projectItemId,
    fieldId: progressFieldId,
    value: Math.round(value * 100) / 100
  });
}

async function calculateProgressForIssue(projectId, issue, projectItems, effortFieldName, progressFieldId) {
  // Check if this issue has sub-issues
  if (!issue.subIssues || issue.subIssues.nodes.length === 0) {
    return null;
  }

  const repoName = `${issue.repository.owner.login}/${issue.repository.name}`;
  console.log(`\n${'='.repeat(70)}`);
  console.log(`📊 Processing: #${issue.number} - ${issue.title}`);
  console.log(`   Repository: ${repoName}`);
  console.log(`   Sub-issues: ${issue.subIssues.nodes.length}`);
  console.log(`${'='.repeat(70)}`);

  let totalEffort = 0;
  let completedEffort = 0;

  // Calculate effort for each sub-issue
  for (const subIssue of issue.subIssues.nodes) {
    // Find the sub-issue in project items to get its effort value
    const subIssueItem = projectItems.find(
      item => item.content && item.content.id === subIssue.id
    );

    const effort = subIssueItem ? getEffortFromItem(subIssueItem, effortFieldName) : 0;
    const isCompleted = subIssue.state === 'CLOSED' && subIssue.stateReason === 'COMPLETED';
    
    console.log(`   ├─ Sub-issue #${subIssue.number}: Effort=${effort}, Status=${subIssue.state}${isCompleted ? ' ✓' : ''}`);
    
    totalEffort += effort;
    if (isCompleted) {
      completedEffort += effort;
    }
  }

  // Calculate percentage
  const completionPercentage = totalEffort > 0 
    ? (completedEffort / totalEffort) * 100 
    : 0;

  console.log(`   ├─ Total Effort: ${totalEffort}`);
  console.log(`   ├─ Completed Effort: ${completedEffort}`);
  console.log(`   └─ Completion: ${completionPercentage.toFixed(2)}%`);

  // Find the parent issue's project item to update it
  const parentItem = projectItems.find(
    item => item.content && item.content.id === issue.id
  );

  if (!parentItem) {
    console.log(`   ⚠️  Warning: Parent issue not found in project items`);
    return null;
  }

  // Update the progress field
  await updateProgressField(
    projectId,
    parentItem.id,
    progressFieldId,
    completionPercentage
  );

  console.log(`   ✅ Updated progress to ${completionPercentage.toFixed(2)}%`);
  
  return {
    issueNumber: issue.number,
    totalEffort,
    completedEffort,
    completionPercentage
  };
}

async function updateAllParentIssues(projectId) {
  console.log('\n🚀 Starting project-wide update...\n');

  // Get project fields
  const fields = await getProjectFields(projectId);
  const effortField = fields.find(f => f.name === CONFIG.effortFieldName);
  const progressField = fields.find(f => f.name === CONFIG.progressFieldName);

  if (!effortField) {
    throw new Error(`Could not find field "${CONFIG.effortFieldName}" in project`);
  }

  if (!progressField) {
    throw new Error(`Could not find field "${CONFIG.progressFieldName}" in project`);
  }

  console.log(`✅ Found Effort field: ${effortField.id}`);
  console.log(`✅ Found Progress field: ${progressField.id}`);

  // Get all project items
  const projectItems = await getAllProjectItems(projectId);

  // Filter for parent issues (issues with sub-issues)
  const parentIssues = projectItems
    .filter(item => 
      item.content && 
      item.content.subIssues && 
      item.content.subIssues.nodes.length > 0
    )
    .map(item => item.content);

  console.log(`\n📌 Found ${parentIssues.length} parent issues with sub-issues\n`);

  if (parentIssues.length === 0) {
    console.log('ℹ️  No parent issues found. Nothing to update.');
    return;
  }

  // Process each parent issue
  const results = [];
  for (const issue of parentIssues) {
    try {
      const result = await calculateProgressForIssue(
        projectId,
        issue,
        projectItems,
        CONFIG.effortFieldName,
        progressField.id
      );
      if (result) {
        results.push(result);
      }
    } catch (error) {
      console.error(`❌ Error processing issue #${issue.number}: ${error.message}`);
    }
  }

  // Summary
  console.log(`\n${'='.repeat(70)}`);
  console.log('📈 Summary');
  console.log(`${'='.repeat(70)}`);
  console.log(`Total parent issues processed: ${results.length}`);
  console.log(`${'='.repeat(70)}\n`);
}

async function updateSpecificIssue(projectId, issueNumber) {
  console.log(`\n🎯 Updating specific issue #${issueNumber}...\n`);

  // Get project fields
  const fields = await getProjectFields(projectId);
  const effortField = fields.find(f => f.name === CONFIG.effortFieldName);
  const progressField = fields.find(f => f.name === CONFIG.progressFieldName);

  if (!effortField || !progressField) {
    throw new Error('Required fields not found in project');
  }

  // Get all project items (we need this to find effort values)
  const projectItems = await getAllProjectItems(projectId);

  // Find the specific issue in project items
  const targetItem = projectItems.find(
    item => item.content && item.content.number === parseInt(issueNumber)
  );

  if (!targetItem || !targetItem.content) {
    throw new Error(`Issue #${issueNumber} not found in project`);
  }

  // Get full issue details with sub-issues
  const issue = await getIssueWithSubIssues(targetItem.content.id);

  // Calculate and update progress
  await calculateProgressForIssue(
    projectId,
    issue,
    projectItems,
    CONFIG.effortFieldName,
    progressField.id
  );
}

// Main execution
async function main() {
  const projectId = process.env.PROJECT_ID;
  const issueNumber = process.env.ISSUE_NUMBER;
  const updateAll = process.env.UPDATE_ALL === 'true';

  if (!projectId) {
    console.error('❌ Error: PROJECT_ID environment variable is required');
    process.exit(1);
  }

  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║     GitHub Effort-Weighted Progress Calculator                 ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');
  console.log(`Project ID: ${projectId}`);
  console.log(`Mode: ${updateAll ? 'Update ALL issues' : issueNumber ? `Update issue #${issueNumber}` : 'Update ALL issues'}\n`);

  try {
    if (updateAll || !issueNumber) {
      await updateAllParentIssues(projectId);
    } else {
      await updateSpecificIssue(projectId, issueNumber);
    }
    
    console.log('\n✅ Process completed successfully!\n');
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    if (error.errors) {
      console.error('GraphQL errors:', JSON.stringify(error.errors, null, 2));
    }
    console.error('\n');
    process.exit(1);
  }
}

main();
