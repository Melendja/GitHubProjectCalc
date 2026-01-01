const { graphql } = require('@octokit/graphql');

const graphqlWithAuth = graphql.defaults({
  headers: {
    authorization: `token ${process.env.GITHUB_TOKEN}`,
  },
});

async function getProjectData() {
  const query = `
    query($owner: String!, $repo: String!, $projectNumber: Int!) {
      repository(owner: $owner, name: $repo) {
        projectV2(number: $projectNumber) {
          id
          fields(first: 20) {
            nodes {
              ... on ProjectV2Field {
                id
                name
              }
              ... on ProjectV2SingleSelectField {
                id
                name
                options {
                  id
                  name
                }
              }
            }
          }
          items(first: 100) {
            nodes {
              id
              type
              fieldValues(first: 20) {
                nodes {
                  ... on ProjectV2ItemFieldTextValue {
                    text
                    field {
                      ... on ProjectV2Field {
                        id
                        name
                      }
                    }
                  }
                  ... on ProjectV2ItemFieldNumberValue {
                    number
                    field {
                      ... on ProjectV2Field {
                        id
                        name
                      }
                    }
                  }
                  ... on ProjectV2ItemFieldSingleSelectValue {
                    name
                    field {
                      ... on ProjectV2SingleSelectField {
                        id
                        name
                      }
                    }
                  }
                }
              }
              content {
                ... on Issue {
                  id
                  title
                  number
                  body
                  trackedIssues(first: 50) {
                    nodes {
                      id
                      title
                      number
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  const [owner, repo] = process.env.GITHUB_REPOSITORY.split('/');
  const projectNumber = parseInt(process.env.PROJECT_NUMBER);

  return await graphqlWithAuth(query, { owner, repo, projectNumber });
}

async function getSubItemsData(subItemNumbers, owner, repo, projectId) {
  const query = `
    query($owner: String!, $repo: String!, $numbers: [Int!]!) {
      repository(owner: $owner, name: $repo) {
        issues(filterBy: {numbers: $numbers}, first: 50) {
          nodes {
            id
            number
            projectItems(first: 10) {
              nodes {
                id
                project {
                  id
                }
                fieldValues(first: 20) {
                  nodes {
                    ... on ProjectV2ItemFieldNumberValue {
                      number
                      field {
                        ... on ProjectV2Field {
                          name
                        }
                      }
                    }
                    ... on ProjectV2ItemFieldSingleSelectValue {
                      name
                      field {
                        ... on ProjectV2SingleSelectField {
                          name
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  const result = await graphqlWithAuth(query, { owner, repo, numbers: subItemNumbers });
  
  // Filter to only include items from our project
  return result.repository.issues.nodes.map(issue => {
    const projectItem = issue.projectItems.nodes.find(item => item.project.id === projectId);
    return {
      number: issue.number,
      projectItemId: projectItem?.id,
      fieldValues: projectItem?.fieldValues.nodes || []
    };
  }).filter(item => item.projectItemId);
}

async function updateCompletionField(projectId, itemId, fieldId, value) {
  const mutation = `
    mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: Float!) {
      updateProjectV2ItemFieldValue(
        input: {
          projectId: $projectId
          itemId: $itemId
          fieldId: $fieldId
          value: { number: $value }
        }
      ) {
        projectV2Item {
          id
        }
      }
    }
  `;

  await graphqlWithAuth(mutation, { projectId, itemId, fieldId, value });
}

function getFieldValue(fieldValues, fieldName) {
  const field = fieldValues.find(fv => fv.field?.name === fieldName);
  if (!field) return null;
  return field.number !== undefined ? field.number : field.name;
}

async function calculateCompletion() {
  console.log('Fetching project data...');
  const data = await getProjectData();
  const project = data.repository.projectV2;
  
  console.log(`Project ID: ${project.id}`);
  
  // Find field IDs
  const effortField = project.fields.nodes.find(f => f.name === 'Effort');
  const statusField = project.fields.nodes.find(f => f.name === 'Status');
  const completionField = project.fields.nodes.find(f => f.name === 'Completion');
  
  if (!effortField || !statusField || !completionField) {
    console.error('Required fields not found!');
    console.log('Available fields:', project.fields.nodes.map(f => f.name));
    return;
  }
  
  console.log(`Effort Field ID: ${effortField.id}`);
  console.log(`Status Field ID: ${statusField.id}`);
  console.log(`Completion Field ID: ${completionField.id}`);
  
  const [owner, repo] = process.env.GITHUB_REPOSITORY.split('/');
  
  // Process each item in the project
  for (const item of project.items.nodes) {
    if (!item.content || item.content.trackedIssues.nodes.length === 0) {
      continue; // Skip items without sub-items
    }
    
    console.log(`\nProcessing User Story: ${item.content.title} (#${item.content.number})`);
    
    // Get sub-item numbers
    const subItemNumbers = item.content.trackedIssues.nodes.map(si => si.number);
    console.log(`Found ${subItemNumbers.length} sub-items`);
    
    // Fetch sub-items data from the project
    const subItems = await getSubItemsData(subItemNumbers, owner, repo, project.id);
    
    let totalEffort = 0;
    let completedEffort = 0;
    
    for (const subItem of subItems) {
      const effort = getFieldValue(subItem.fieldValues, 'Effort') || 0;
      const status = getFieldValue(subItem.fieldValues, 'Status');
      
      console.log(`  Sub-item #${subItem.number}: Effort=${effort}, Status=${status}`);
      
      totalEffort += effort;
      
      if (status === 'Completed' || status === 'Done' || status === 'Complete') {
        completedEffort += effort;
      }
    }
    
    // Calculate completion percentage
    const completionPercent = totalEffort > 0 ? Math.round((completedEffort / totalEffort) * 100) : 0;
    
    console.log(`Total Effort: ${totalEffort}`);
    console.log(`Completed Effort: ${completedEffort}`);
    console.log(`Completion: ${completionPercent}%`);
    
    // Update the Completion field
    await updateCompletionField(project.id, item.id, completionField.id, completionPercent);
    console.log(`✓ Updated completion to ${completionPercent}%`);
   // Trigger Power Automate when completion is updated
    try {
  const [owner, repo] = process.env.GITHUB_REPOSITORY.split('/');
  await fetch('YOUR_POWER_AUTOMATE_URL_HEREhttps://default5189c9b58f004a4599f4ca88b51282.bf.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/c3b8f461303748a99bea551d3834acf4/triggers/manual/paths/invoke?api-version=1',
     {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      issueNumber: item.content.number,
      issueTitle: item.content.title,
      completion: completionPercent,
      repository: `${owner}/${repo}`
    })
  });
  console.log('✓ Triggered Power Automate flow');
} catch (error) {
  console.log('⚠ Power Automate trigger failed:', error.message);
}

  }
  
  console.log('\n✓ All User Stories updated!');
}

// Run the script
calculateCompletion().catch(error => {
  console.error('Error:', error);
  process.exit(1);
});
