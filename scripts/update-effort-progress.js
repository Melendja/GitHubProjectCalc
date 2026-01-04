const { graphql } = require('@octokit/graphql');

// Configuration - UPDATE THESE VALUES
const CONFIG = {
  projectId: process.env.PROJECT_ID, // Your project node ID
  effortFieldName: 'Effort',         // Name of your effort custom field
  progressFieldName: 'Completion %'  // Name of your progress custom field
};

const graphqlWithAuth = graphql.defaults({
  headers: {
    authorization: `token ${process.env.GITHUB_TOKEN}`,
  },
});

async function getIssueDetails(owner, repo, issueNumber) {
  const query = `
    query($owner: String!, $repo: String!, $issueNumber: Int!) {
      repository(owner: $owner, name: $repo) {
        issue(number: $issueNumber) {
          id
          number
          title
          state
          parent {
            id
            number
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

  const result = await graphqlWithAuth(query, {
    owner,
    repo,
    issueNumber: parseInt(issueNumber),
    headers: {
      'GraphQL-Features': 'sub_issues'
    }
  });

  return result.repository.issue;
}

async function getProjectFields(projectId) {
  const query = `
    query($projectId: ID!) {
      node(id: $projectId) {
        ... on ProjectV2 {
          id
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
  return result.node.fields.nodes;
}

async function getProjectItem(projectId, issueId) {
  const query = `
    query($projectId: ID!, $issueId: ID!) {
      node(id: $projectId) {
        ... on ProjectV2 {
          items(first: 100) {
            nodes {
              id
              content {
                ... on Issue {
                  id
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
                  ... on ProjectV2ItemFieldTextValue {
                    field {
                      ... on ProjectV2Field {
                        id
                        name
                      }
                    }
                    text
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  const result = await graphqlWithAuth(query, { projectId, issueId });
  const items = result.node.items.nodes;
  
  // Find the item that matches our issue
  const item = items.find(item => item.content && item.content.id === issueId);
  return item;
}

async function getEffortForIssue(projectId, issueId, effortFieldName) {
  const item = await getProjectItem(projectId, issueId);
  
  if (!item) {
    console.log(`Issue ${issueId} not found in project`);
    return 0;
  }

  // Find the Effort field value
  const effortValue = item.fieldValues.nodes.find(
    fv => fv.field && fv.field.name === effortFieldName
  );

  return effortValue ? (effortValue.number || 0) : 0;
}

async function updateProgressField(projectId, parentIssueId, progressFieldId, value) {
  // First, get the project item ID for the parent issue
  const item = await getProjectItem(projectId, parentIssueId);
  
  if (!item) {
    console.log(`Parent issue not found in project`);
    return;
  }

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
    itemId: item.id,
    fieldId: progressFieldId,
    value: Math.round(value * 100) / 100 // Round to 2 decimal places
  });
}

async function calculateEffortWeightedProgress(owner, repo, issueNumber, projectId) {
  console.log(`Processing issue #${issueNumber}...`);

  // Get issue details
  const issue = await getIssueDetails(owner, repo, issueNumber);
  console.log(`Issue state: ${issue.state}`);

  // Determine which issue to update (if this is a sub-issue, update parent)
  let targetIssue = issue;
  if (issue.parent) {
    console.log(`This is a sub-issue of #${issue.parent.number}`);
    targetIssue = await getIssueDetails(owner, repo, issue.parent.number);
  }

  // Check if this issue has sub-issues
  if (!targetIssue.subIssues || targetIssue.subIssues.nodes.length === 0) {
    console.log(`Issue #${targetIssue.number} has no sub-issues, skipping...`);
    return;
  }

  console.log(`Found ${targetIssue.subIssues.nodes.length} sub-issues`);

  // Get project fields
  const fields = await getProjectFields(projectId);
  const effortField = fields.find(f => f.name === CONFIG.effortFieldName);
  const progressField = fields.find(f => f.name === CONFIG.progressFieldName);

  if (!effortField) {
    console.error(`Error: Could not find field "${CONFIG.effortFieldName}" in project`);
    return;
  }

  if (!progressField) {
    console.error(`Error: Could not find field "${CONFIG.progressFieldName}" in project`);
    return;
  }

  console.log(`Found Effort field: ${effortField.id}`);
  console.log(`Found Progress field: ${progressField.id}`);

  // Calculate effort-weighted progress
  let totalEffort = 0;
  let completedEffort = 0;

  for (const subIssue of targetIssue.subIssues.nodes) {
    const effort = await getEffortForIssue(projectId, subIssue.id, CONFIG.effortFieldName);
    const isCompleted = subIssue.state === 'CLOSED' && subIssue.stateReason === 'COMPLETED';
    
    console.log(`  Sub-issue #${subIssue.number}: Effort=${effort}, Completed=${isCompleted}`);
    
    totalEffort += effort;
    if (isCompleted) {
      completedEffort += effort;
    }
  }

  // Calculate percentage
  const completionPercentage = totalEffort > 0 
    ? (completedEffort / totalEffort) * 100 
    : 0;

  console.log(`Total Effort: ${totalEffort}`);
  console.log(`Completed Effort: ${completedEffort}`);
  console.log(`Completion: ${completionPercentage.toFixed(2)}%`);

  // Update the parent issue's progress field
  await updateProgressField(
    projectId,
    targetIssue.id,
    progressField.id,
    completionPercentage
  );

  console.log(`✅ Updated progress for issue #${targetIssue.number}`);
}

// Main execution
async function main() {
  const [owner, repo] = process.env.REPOSITORY.split('/');
  const issueNumber = process.env.ISSUE_NUMBER;
  const projectId = process.env.PROJECT_ID;

  if (!projectId) {
    console.error('Error: PROJECT_ID environment variable is required');
    process.exit(1);
  }

  try {
    await calculateEffortWeightedProgress(owner, repo, issueNumber, projectId);
  } catch (error) {
    console.error('Error:', error.message);
    if (error.errors) {
      console.error('GraphQL errors:', JSON.stringify(error.errors, null, 2));
    }
    process.exit(1);
  }
}

main();
