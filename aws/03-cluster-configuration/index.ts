import * as aws from "@pulumi/aws";
import * as eks from "@pulumi/eks";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { config } from "./config";

const projectName = pulumi.getProject();

export const adminsIamRoleArn = config.adminsIamRoleArn
export const devsIamRoleArn = config.devsIamRoleArn
export const stdNodegroupIamRoleArn = config.stdNodegroupIamRoleArn
export const perfNodegroupIamRoleArn = config.perfNodegroupIamRoleArn
const adminsIamRoleName = adminsIamRoleArn.apply(s => s.split("/")).apply(s => s[1])
const devsIamRoleName = devsIamRoleArn.apply(s => s.split("/")).apply(s => s[1])
const stdNodegroupIamRoleName = stdNodegroupIamRoleArn.apply(s => s.split("/")).apply(s => s[1])
const perfNodegroupIamRoleName = perfNodegroupIamRoleArn.apply(s => s.split("/")).apply(s => s[1])

// Create an EKS cluster.
const cluster = new eks.Cluster(`${projectName}`, {
    instanceRoles: [
        aws.iam.Role.get("adminsIamRole", stdNodegroupIamRoleName),
        aws.iam.Role.get("devsIamRole", perfNodegroupIamRoleName),
    ],
    roleMappings: [
        {
            roleArn: config.adminsIamRoleArn,
            groups: ["system:masters"],
            username: "pulumi:admins",
        },
        {
            roleArn: config.devsIamRoleArn,
            groups: ["pulumi:devs"],
            username: "pulumi:alice",
        },
    ],
    vpcId: config.vpcId,
    publicSubnetIds: config.publicSubnetIds,
    privateSubnetIds: config.privateSubnetIds,
    storageClasses: {
        "gp2": { type: "gp2", encrypted: true},
        "sc1": { type: "sc1"}
    },
    nodeAssociatePublicIpAddress: false,
    skipDefaultNodeGroup: true,
    deployDashboard: false,
    version: "1.14",
    tags: {
        "Project": "k8s-aws-cluster",
        "Org": "pulumi",
    },
    clusterSecurityGroupTags: { "ClusterSecurityGroupTag": "true" },
    nodeSecurityGroupTags: { "NodeSecurityGroupTag": "true" },
    enabledClusterLogTypes: ["api", "audit", "authenticator", "controllerManager", "scheduler"],
    // endpointPublicAccess: false,     // Requires bastion to access cluster API endpoint
    // endpointPrivateAccess: true,     // Requires bastion to access cluster API endpoint
});

// Export the cluster details.
export const kubeconfig = cluster.kubeconfig;
export const clusterName = cluster.core.cluster.name;

// Create a Standard node group of t2.medium workers.
const ngStandard = new eks.NodeGroup(`${projectName}-ng-standard`, {
    cluster: cluster,
    instanceProfile: new aws.iam.InstanceProfile("ng-standard-instanceProfile", {role: stdNodegroupIamRoleName}),
    nodeAssociatePublicIpAddress: false,
    nodeSecurityGroup: cluster.nodeSecurityGroup,
    clusterIngressRule: cluster.eksClusterIngressRule,
    amiId: "ami-0ca5998dc2c88e64b", // k8s v1.14.7 in us-west-2
    instanceType: "t2.medium",
    desiredCapacity: 3,
    minSize: 3,
    maxSize: 10,
    labels: {"amiId": "ami-0ca5998dc2c88e64b"},
    cloudFormationTags: clusterName.apply(clusterName => ({
        "CloudFormationGroupTag": "true",
        "k8s.io/cluster-autoscaler/enabled": "true",
        [`k8s.io/cluster-autoscaler/${clusterName}`]: "true",
    })),
}, {
    providers: { kubernetes: cluster.provider},
});

// Create a 2xlarge node group of t3.2xlarge workers with taints for special workloads.
const ng2xlarge = new eks.NodeGroup(`${projectName}-ng-2xlarge`, {
    cluster: cluster,
    instanceProfile: new aws.iam.InstanceProfile("ng-2xlarge-instanceProfile", {role: perfNodegroupIamRoleName}),
    nodeAssociatePublicIpAddress: false,
    nodeSecurityGroup: cluster.nodeSecurityGroup,
    clusterIngressRule: cluster.eksClusterIngressRule,
    amiId: "ami-0ca5998dc2c88e64b", // k8s v1.14.7 in us-west-2
    instanceType: "t3.2xlarge",
    desiredCapacity: 3,
    minSize: 3,
    maxSize: 10,
    labels: {"amiId": "ami-0ca5998dc2c88e64b"},
    taints: { "special": { value: "true", effect: "NoSchedule"}},
    cloudFormationTags: clusterName.apply(clusterName => ({
        "CloudFormationGroupTag": "true",
        "k8s.io/cluster-autoscaler/enabled": "true",
        [`k8s.io/cluster-autoscaler/${clusterName}`]: "true",
    })),
}, {
    providers: { kubernetes: cluster.provider},
});

// Create Kubernetes namespaces.
const clusterSvcsNamespace = new k8s.core.v1.Namespace("cluster-svcs", undefined, { provider: cluster.provider });
export const clusterSvcsNamespaceName = clusterSvcsNamespace.metadata.name;

const appSvcsNamespace = new k8s.core.v1.Namespace("app-svcs", undefined, { provider: cluster.provider });
export const appSvcsNamespaceName = appSvcsNamespace.metadata.name;

const appNamespace = new k8s.core.v1.Namespace("apps", undefined, { provider: cluster.provider });
export const appNamespaceName = appNamespace.metadata.name;

// Create a resource quota in the apps namespace.
const quotaAppNamespace = new k8s.core.v1.ResourceQuota("apps", {
    metadata: {namespace: appNamespaceName},
    spec: {
        hard: {
            cpu: "20",
            memory: "1Gi",
            pods: "10",
            replicationcontrollers: "20",
            resourcequotas: "1",
            services: "5",
        },
    }
},{
    provider: cluster.provider
});

// Create a limited role for the `pulumi:devs` to use in the apps namespace.
let devsGroupRole = new k8s.rbac.v1.Role("pulumi-devs",
    {
        metadata: {
            namespace: appNamespaceName,
        },
        rules: [
            {
                apiGroups: ["", "apps"],
                resources: ["pods", "services", "deployments", "replicasets", "persistentvolumeclaims"],
                verbs: ["get", "list", "watch", "create", "update", "delete"],
            },
        ],
    },
    {
        provider: cluster.provider,
    },
);

// Bind the `pulumi:devs` RBAC group to the new, limited role.
let devsGroupRoleBinding = new k8s.rbac.v1.RoleBinding("pulumi-devs", {
	metadata: {
		namespace: appNamespaceName,
	},
    subjects: [{
        kind: "Group",
        name: "pulumi:devs",
    }],
    roleRef: {
        kind: "Role",
        name: devsGroupRole.metadata.name,
        apiGroup: "rbac.authorization.k8s.io",
    },
}, {provider: cluster.provider});
